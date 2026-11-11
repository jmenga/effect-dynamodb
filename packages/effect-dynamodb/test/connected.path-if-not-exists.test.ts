/**
 * A `pathIfNotExists` operand a check refuses, against DynamoDB Local (#236): refused only where it
 * would be stored, where the row lacks its path. Every write path an update with a path operation
 * takes (`helpers/PathIfNotExistsFallback.ts`), alone and in a transaction, at a top-level
 * attribute, a struct's property and a sparse map's entry's property. Where the row holds the
 * path, DynamoDB keeps the stored value and the update is written; where it lacks it, the update
 * is refused and the table is as it was. Each name ends with what 1.40.0 did there, measured on
 * DynamoDB Local.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import { Cause, Config, Effect, Exit, Layer } from "effect"
import { describe, expect } from "vitest"
import * as Lib from "../src/index.js"
import {
  definitions,
  paths,
  positions,
  seed,
  send,
  valueAt,
} from "./helpers/PathIfNotExistsFallback.js"

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

type Outcome = {
  readonly failure: { readonly tag: string; readonly operation: unknown } | undefined
  /** Whether no row changed. */
  readonly unchanged: boolean
  /** The updated row as it reads, if it does. */
  readonly read: unknown
}

let tables = 0
/** Seeds the rows on a fresh table, sends the update of `id`, and gives what it did. */
const outcome = (
  path: (typeof paths)[number],
  segments: ReadonlyArray<string | number>,
  id: "here" | "absent" | "orphan",
  transaction: boolean,
  expectedVersion?: number,
): Effect.Effect<Outcome, unknown> => {
  const { E, Main } = definitions(path)
  const tableName = `path-if-not-exists-${Date.now()}-${tables++}`
  const scan = Effect.promise(() =>
    raw.send(new ScanCommand({ TableName: tableName, ConsistentRead: true })),
  ).pipe(
    Effect.map((out) =>
      (out.Items ?? []).map((item) => JSON.stringify(item)).sort((a, b) => a.localeCompare(b)),
    ),
  )
  const sent =
    expectedVersion === undefined
      ? path
      : { ...path, prefix: (u: any) => path.prefix(u).expectedVersion(expectedVersion) }
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
        for (const row of ["here", "absent", "orphan", "other"] as const) {
          yield* db.entities.E.put(seed(row)).asEffect()
        }
        const before = yield* scan
        const exit = yield* Effect.exit(
          send(db, sent, segments, id, -1, transaction) as Effect.Effect<unknown, unknown>,
        )
        const unchanged = JSON.stringify(yield* scan) === JSON.stringify(before)
        const read = yield* Effect.exit(db.entities.E.get({ id }))
        const failure = Exit.isFailure(exit) ? (Cause.squash(exit.cause) as any) : undefined
        return {
          failure:
            failure === undefined ? undefined : { tag: failure._tag, operation: failure.operation },
          unchanged,
          read: Exit.isSuccess(read) ? read.value : undefined,
        }
      }),
    () =>
      Effect.gen(function* () {
        const client = yield* Lib.DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(Effect.ignore),
  ).pipe(
    Effect.provide(Layer.merge(ClientLayer, Main.layer({ name: tableName }) as Layer.Layer<never>)),
  ) as Effect.Effect<Outcome, unknown>
}

const REFUSED = { tag: "ValidationError", operation: "update.pathIfNotExists" }

describeConnected(
  "pathIfNotExists: an operand a check refuses is refused only where stored",
  () => {
    for (const path of paths) {
      for (const position of positions) {
        for (const transaction of [false, true]) {
          const at = `${path.name} | ${position.name} | ${transaction ? "in a transaction" : "alone"}`
          it.effect(
            `${at} | the row holds the path: written, value kept | 1.40.0: ${position.on140.here}`,
            () =>
              Effect.gen(function* () {
                const got = yield* outcome(path, position.segments, "here", transaction)
                expect(got.failure).toBeUndefined()
                expect(valueAt(got.read, position.segments)).toBe(1)
              }),
          )
          it.effect(
            `${at} | the row lacks the path: refused, nothing written | 1.40.0: ${position.on140.absent}`,
            () =>
              Effect.gen(function* () {
                const got = yield* outcome(path, position.segments, "absent", transaction)
                expect(got.failure).toEqual(REFUSED)
                expect(got.unchanged).toBe(true)
                expect(got.read).toBeDefined()
              }),
          )
        }
      }
    }

    for (const transaction of [false, true]) {
      it.effect(
        `plain | a struct the row lacks, holding the path | ${transaction ? "in a transaction" : "alone"} | refused, nothing written | 1.40.0: ${positions[1]!.on140.absent}`,
        () =>
          Effect.gen(function* () {
            const got = yield* outcome(paths[0]!, ["meta", "n"], "orphan", transaction)
            expect(got.failure).toEqual(REFUSED)
            expect(got.unchanged).toBe(true)
          }),
      )
    }

    const versioned = paths.find((path) => path.name.startsWith("versioned"))!
    const unexpecting = { ...versioned, prefix: (u: any) => u }
    for (const position of positions) {
      for (const id of ["here", "absent"] as const) {
        for (const transaction of [false, true]) {
          it.effect(
            `versioned, expecting another version | ${position.name} | the row ${id === "here" ? "holds" : "lacks"} the path | ${transaction ? "in a transaction" : "alone"} | OptimisticLockError | 1.40.0: ${position.on140.stale}`,
            () =>
              Effect.gen(function* () {
                const got = yield* outcome(unexpecting, position.segments, id, transaction, 7)
                expect(got.failure?.tag).toBe("OptimisticLockError")
                expect(got.unchanged).toBe(true)
              }),
          )
        }
      }
    }
  },
)
