/**
 * What an aggregate `create` hydrates from an edge's `entity`, against DynamoDB Local: the shapes of
 * `fixtures/ref-hydration-1.39.0.json` (`helpers/RefHydrationShapes.ts`). A `many` element that is the
 * entity's own model, given whole, is stored as given; an entity without a `DynamoModel.identifier`,
 * or whose identifier is another field, is fetched by its key's only composite, and writes the rows
 * 1.39.0 wrote for the same shape with its identifier on the key; an entity no one id keys fails with
 * `EDD-9129`, nothing written. 1.39.0 died on each of these.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { type AttributeValue, DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { Cause, Config, Effect, Exit, Layer } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Table from "../src/Table.js"
import {
  byKey,
  CONTROLS,
  fixture,
  SHAPES,
  type Shape,
  schema,
  UNFETCHABLE,
  WRITES_AS,
} from "./helpers/RefHydrationShapes.js"

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

type Row = Record<string, AttributeValue>

let tables = 0
/** Seeds the entity's rows on a fresh table, then runs `create` and `get`. */
const run = (shape: Shape) => {
  const tableName = `ref-hydration-${Date.now()}-${tables++}`
  const Base = Table.make({ schema, entities: shape.entities } as never) as any
  const A = shape.make(Base)
  const Tb = { ...Base, aggregates: { A } }
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const client = yield* DynamoClient
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
        const edb: any = yield* DynamoClient.make({
          entities: shape.entities,
          tables: { Base },
        } as never) as Effect.Effect<any>
        for (const item of shape.seed) yield* edb.entities.Lines.put(item).asEffect()
        const db: any = yield* DynamoClient.make({
          entities: {},
          aggregates: { A },
          tables: { Tb },
        } as never) as Effect.Effect<any>
        const create = yield* Effect.exit(
          db.aggregates.A.create(shape.input) as Effect.Effect<unknown>,
        )
        const rows = yield* Effect.promise(async () => {
          const scan = await raw.send(
            new ScanCommand({ TableName: tableName, ConsistentRead: true }),
          )
          return (scan.Items ?? []) as ReadonlyArray<Row>
        })
        const get = yield* Effect.exit(db.aggregates.A.get({ id: "a" }) as Effect.Effect<unknown>)
        return { create, rows, get }
      }),
    () =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(Effect.ignore),
  ).pipe(
    Effect.provide(Layer.merge(ClientLayer, Base.layer({ name: tableName }))),
  ) as unknown as Effect.Effect<{
    create: Exit.Exit<unknown, unknown>
    rows: ReadonlyArray<Row>
    get: Exit.Exit<unknown, unknown>
  }>
}

describeConnected(
  "aggregate create hydrates an edge's entity by the key its id is (connected)",
  () => {
    for (const [label, writesAs] of Object.entries(WRITES_AS)) {
      it.effect(`${label}: writes the rows 1.39.0 wrote with its identifier on the key`, () =>
        Effect.gen(function* () {
          const { create, rows, get } = yield* run(SHAPES[label]!())
          expect(Exit.isSuccess(create)).toBe(true)
          expect(byKey(rows)).toEqual(byKey(fixture.shapes[writesAs]!.rows))
          expect(Exit.isSuccess(get) && `ok ${JSON.stringify(get.value)}`).toBe(
            fixture.shapes[writesAs]!.get,
          )
        }),
      )
    }

    it.effect("many, element the entity's struct, given whole: stored as given", () =>
      Effect.gen(function* () {
        const { create, rows, get } = yield* run(
          SHAPES["many, element the entity's struct, given whole"]!(),
        )
        expect(Exit.isSuccess(create)).toBe(true)
        expect(byKey(rows).map((row) => `${row.__edd_e__?.S} ${row.sk?.S}`)).toEqual([
          "AggLine $hydrate#v1#aggline#l",
          "Root $hydrate#v1#root",
        ])
        expect(Exit.isSuccess(get) && get.value).toEqual({
          id: "a",
          lines: [{ lineId: "l", f: 5 }],
        })
      }),
    )

    for (const label of CONTROLS) {
      it.effect(`${label}: writes and reads what 1.39.0 did`, () =>
        Effect.gen(function* () {
          const { create, rows, get } = yield* run(SHAPES[label]!())
          expect(Exit.isSuccess(create) && `ok ${JSON.stringify(create.value)}`).toBe(
            fixture.shapes[label]!.create,
          )
          expect(byKey(rows)).toEqual(byKey(fixture.shapes[label]!.rows))
          expect(Exit.isSuccess(get) && `ok ${JSON.stringify(get.value)}`).toBe(
            fixture.shapes[label]!.get,
          )
        }),
      )
    }

    for (const label of UNFETCHABLE) {
      it.effect(`${label}: create fails with EDD-9129, nothing written`, () =>
        Effect.gen(function* () {
          const { create, rows } = yield* run(SHAPES[label]!())
          expect(Exit.isFailure(create)).toBe(true)
          const error = Cause.squash((create as Exit.Failure<unknown, unknown>).cause)
          expect(error).toBeInstanceOf(ValidationError)
          expect(String((error as ValidationError).cause)).toContain("[EDD-9129]")
          expect(rows.map((row) => row.__edd_e__?.S)).toEqual(["Line"])
        }),
      )
    }
  },
)
