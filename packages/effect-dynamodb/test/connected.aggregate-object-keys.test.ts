/**
 * `AggregateObjectKeys.test.ts` against DynamoDB Local (#242, `EDD-9162`): a `create` composing an
 * aggregate key from an object is refused with nothing written, and the rows published 1.40.0
 * wrote under `[object object]` (`fixtures/aggregate-object-keys-1.40.0.json`) are read, listed,
 * updated and deleted as they were.
 */
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  PutItemCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { Cause, Config, Effect, Exit } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import {
  define,
  fixture,
  INTO,
  keyOf,
  outcome,
  type Row,
  SHAPES,
  type Shape,
  valueOf,
} from "./helpers/AggregateObjectKeys.js"

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
const ClientLayer = DynamoClient.layer({ region: "us-east-1", endpoint: ENDPOINT, credentials })

const send = <A>(make: () => Promise<A>) =>
  Effect.tryPromise(make).pipe(Effect.orDie) as Effect.Effect<A>

let tables = 0

/** `shape`'s aggregate over a fresh table holding `seed`, with the table's rows to hand. */
const on = <A>(
  shape: Shape,
  seed: ReadonlyArray<Row>,
  body: (db: any, rows: Effect.Effect<ReadonlyArray<Row>>) => Effect.Effect<A, unknown, any>,
) => {
  const { Base, Roots, Main } = define(shape)
  const TableName = `aggregate-object-keys-${Date.now()}-${tables++}`
  return Effect.gen(function* () {
    yield* send(() =>
      raw.send(
        new CreateTableCommand({
          TableName,
          BillingMode: "PAY_PER_REQUEST",
          AttributeDefinitions: ["pk", "sk", "gsi1pk", "gsi1sk", "lsi1sk"].map((name) => ({
            AttributeName: name,
            AttributeType: "S",
          })),
          KeySchema: [
            { AttributeName: "pk", KeyType: "HASH" },
            { AttributeName: "sk", KeyType: "RANGE" },
          ],
          GlobalSecondaryIndexes: [
            {
              IndexName: "gsi1",
              KeySchema: [
                { AttributeName: "gsi1pk", KeyType: "HASH" },
                { AttributeName: "gsi1sk", KeyType: "RANGE" },
              ],
              Projection: { ProjectionType: "ALL" },
            },
          ],
          LocalSecondaryIndexes: [
            {
              IndexName: "lsi1",
              KeySchema: [
                { AttributeName: "pk", KeyType: "HASH" },
                { AttributeName: "lsi1sk", KeyType: "RANGE" },
              ],
              Projection: { ProjectionType: "ALL" },
            },
          ],
        }),
      ),
    )
    const db = yield* DynamoClient.make({
      entities: {},
      aggregates: { Roots },
      tables: { Main },
    } as never) as Effect.Effect<any, never, any>
    for (const Item of seed) yield* send(() => raw.send(new PutItemCommand({ TableName, Item })))
    const rows = Effect.map(
      send(() => raw.send(new ScanCommand({ TableName, ConsistentRead: true }))),
      (out) => sorted((out.Items ?? []) as unknown as ReadonlyArray<Row>),
    )
    return yield* Effect.ensuring(
      body(db, rows),
      Effect.ignore(send(() => raw.send(new DeleteTableCommand({ TableName })))),
    )
  }).pipe(
    Effect.provide(Base.layer({ name: TableName })),
    Effect.provide(ClientLayer),
  ) as Effect.Effect<A, unknown>
}

const sorted = (rows: ReadonlyArray<Row>) =>
  [...rows].sort((x, y) => `${x.pk?.S}|${x.sk?.S}`.localeCompare(`${y.pk?.S}|${y.sk?.S}`))

const refusalOf = (exit: Exit.Exit<unknown, unknown>): string => {
  expect(Exit.isFailure(exit)).toBe(true)
  const error = Cause.squash((exit as Exit.Failure<unknown, unknown>).cause) as ValidationError
  expect(error).toBeInstanceOf(ValidationError)
  return String(error.cause)
}

describeConnected("an object as an aggregate key composite against DynamoDB Local", () => {
  for (const shape of SHAPES) {
    const { results, rows: written } = fixture.shapes[shape]

    it.effect(`${shape}: create is refused, nothing written`, () =>
      on(shape, [], (db, rows) =>
        Effect.gen(function* () {
          const value =
            shape === "discriminator"
              ? valueOf(shape, "a")
              : { ...valueOf(shape, "a"), f: { a: 1 } }
          const said = refusalOf(yield* Effect.exit(db.aggregates.Roots.create(value)))
          expect(said).toContain(INTO[shape])
          expect(said).toContain("[EDD-9162]")
          expect(yield* rows).toEqual([])
        }),
      ),
    )

    it.effect(`${shape}: 1.40.0's rows are read, updated and deleted as they were`, () =>
      on(shape, written, (db, rows) =>
        Effect.gen(function* () {
          for (const id of ["a", "b"] as const) {
            const got: Exit.Exit<any, unknown> = yield* Effect.exit(
              db.aggregates.Roots.get(keyOf(shape, id)),
            )
            expect(
              Exit.isSuccess(got) ? { id: got.value.id, f: got.value.f } : outcome(got),
            ).toEqual(results[`get${id.toUpperCase()}`])
          }
          if (results.list !== undefined) {
            const listed = yield* db.aggregates.Roots.list(
              shape === "listPartitionKey" ? { f: { a: 1 } } : {},
            )
            expect(listed.data.map((x: { id: string }) => x.id).sort()).toEqual(results.list)
          }
          const update = yield* Effect.exit(
            db.aggregates.Roots.update(keyOf(shape, "a"), ({ state }: any) => ({
              ...state,
              note: "two",
            })),
          )
          if (shape === "discriminator") {
            expect(outcome(update)).toBe("ValidationError")
            expect(yield* rows).toEqual(sorted(written))
          } else {
            expect(outcome(update)).toBe("ok")
            expect(yield* rows).toEqual(
              sorted(
                written.map((row) =>
                  row.id?.S === "a" || shape === "partitionKey"
                    ? { ...row, note: { S: "two" } }
                    : row,
                ),
              ),
            )
          }
          if (
            shape === "listSortKey" ||
            shape === "listPartitionKey" ||
            shape === "collectionSortKey"
          ) {
            const before = yield* rows
            const said = refusalOf(
              yield* Effect.exit(
                db.aggregates.Roots.update({ id: "a" }, ({ state }: any) => ({
                  ...state,
                  f: { a: 3 },
                })),
              ),
            )
            expect(said).toContain(INTO[shape])
            expect(yield* rows).toEqual(before)
          }
          yield* db.aggregates.Roots.delete(keyOf(shape, "a"))
          expect((yield* rows).filter((row) => row.pk?.S === "$ao#v1#roots#a")).toEqual([])
          if (shape === "partitionKey") {
            expect(yield* rows).toEqual([])
          } else {
            expect((yield* rows).filter((row) => row.pk?.S === "$ao#v1#roots#b")).toHaveLength(
              shape === "discriminator" ? 2 : 1,
            )
          }
        }),
      ),
    )
  }
})
