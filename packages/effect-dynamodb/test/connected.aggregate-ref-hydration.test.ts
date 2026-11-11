/**
 * What an aggregate `create` hydrates from an edge's `entity`, against DynamoDB Local: the shapes of
 * `fixtures/ref-hydration-1.39.0.json` (`helpers/RefHydrationShapes.ts`). A `many` element that is the
 * entity's own model, given whole, is stored as given; an entity without a `DynamoModel.identifier`,
 * or whose identifier is another field, is fetched by its key's only composite, and writes the rows
 * 1.39.0 wrote for the same shape with its identifier on the key; an entity no one id keys fails with
 * `EDD-9129`, nothing written. 1.39.0 died on each of these. Shapes 1.39.0 hydrated as it should
 * (a key composite in both halves, `Date` and `NumberFromString` keys, alone or in a wrapper) write
 * and read what it did; an id of the key composite's own type 1.39.0 dropped, or fetched under a key
 * `put` never wrote (a string codec), is fetched by the key `put` wrote; an id of no type of it, or
 * one no item is keyed by (`put` refuses it, alone or inside a struct, an `Option` or a `Result`),
 * fails with `EDD-9131`, nothing written. An element whose definition doesn't say it holds the
 * entity (a union, one through a transformation or `suspend`, one declaring the entity's field a
 * string, an `Option`, a `Result` or another struct, or declaring its id itself) is judged as 1.39.0
 * judged it (a string `lineId`, whatever the element declares), so each writes and reads what
 * 1.39.0 did. So does an element of a class of the entity's identifier that isn't its model, and a
 * `one` edge given the entity whole beside an id its model declares, or an id of another type than
 * a string: the entity given whole is stored as given.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { type AttributeValue, DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { Cause, Config, Effect, Exit, Layer, Option } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Table from "../src/Table.js"
import {
  byKey,
  CONTROLS,
  EIGHTH,
  fixture,
  JUDGED_AS_139,
  json,
  NINTH,
  NOW_FETCHED,
  OWN_KEY_WHOLE,
  outcomeOf,
  SHAPES,
  type Shape,
  SIXTH,
  schema,
  UNFETCHABLE,
  UNIONS,
  UNKEYABLE,
  UNSTORABLE,
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

/**
 * The message of the `ValidationError` a failed `create` failed with. An id is a caller's input,
 * so it is refused on the error channel, never as a defect.
 */
const refusal = (create: Exit.Exit<unknown, unknown>) => {
  expect(Exit.isFailure(create)).toBe(true)
  const cause = (create as Exit.Failure<unknown, unknown>).cause
  expect(Cause.hasDies(cause)).toBe(false)
  const error = Option.getOrUndefined(Cause.findErrorOption(cause))
  expect(error).toBeInstanceOf(ValidationError)
  return String((error as ValidationError).cause)
}

let tables = 0
/** Seeds the entity's rows on a fresh table, then runs `create` and `get`. */
const run = (shape: Shape) => {
  const tableName = `ref-hydration-${Date.now()}-${tables++}`
  const Base = Table.make({
    schema: shape.schema ?? schema,
    entities: shape.entities,
  } as never) as any
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
        for (const [member, item] of shape.seed) yield* edb.entities[member].put(item).asEffect()
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
          expect(Exit.isSuccess(get) && `ok ${json(get.value)}`).toBe(fixture.shapes[writesAs]!.get)
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
          expect(Exit.isSuccess(create) && `ok ${json(create.value)}`).toBe(
            fixture.shapes[label]!.create,
          )
          expect(byKey(rows)).toEqual(byKey(fixture.shapes[label]!.rows))
          expect(Exit.isSuccess(get) && `ok ${json(get.value)}`).toBe(fixture.shapes[label]!.get)
        }),
      )
    }

    for (const label of UNFETCHABLE) {
      it.effect(`${label}: create fails with EDD-9129, nothing written`, () =>
        Effect.gen(function* () {
          const { create, rows } = yield* run(SHAPES[label]!())
          expect(refusal(create)).toContain("[EDD-9129]")
          expect(rows.map((row) => row.__edd_e__?.S)).toEqual(["Line"])
        }),
      )
    }

    for (const label of NOW_FETCHED) {
      it.effect(`${label}: fetched by the key Entity.put wrote`, () =>
        Effect.gen(function* () {
          const { create, rows, get } = yield* run(SHAPES[label]!())
          expect(Exit.isSuccess(create)).toBe(true)
          const seeded = fixture.shapes[label]!.seeded
          expect(byKey(rows.filter((row) => row.__edd_e__?.S === "Line"))).toEqual(byKey(seeded))
          const edge = rows.find((row) => row.__edd_e__?.S === "AggLine")!
          expect({ lineId: edge.lineId, f: edge.f }).toEqual({
            lineId: seeded[0]!.lineId,
            f: seeded[0]!.f,
          })
          expect(Exit.isSuccess(get) && get.value).toEqual(Exit.isSuccess(create) && create.value)
        }),
      )
    }

    for (const label of [
      ...UNIONS,
      ...JUDGED_AS_139,
      "many, element declares the entity's field a string, given it and a lineId",
      ...SIXTH,
      ...EIGHTH,
      ...NINTH,
    ]) {
      it.effect(`${label}: writes and reads what 1.39.0 did`, () =>
        Effect.gen(function* () {
          const { create, rows, get } = yield* run(SHAPES[label]!())
          expect(outcomeOf(create)).toBe(fixture.shapes[label]!.create)
          expect(byKey(rows)).toEqual(byKey(fixture.shapes[label]!.rows))
          expect(outcomeOf(get)).toBe(fixture.shapes[label]!.get)
        }),
      )
    }

    for (const label of OWN_KEY_WHOLE) {
      it.effect(`${label}: stored as given`, () =>
        Effect.gen(function* () {
          const { create, rows, get } = yield* run(SHAPES[label]!())
          const lines = [{ lineId: "l", f: 9 }]
          const sub = label.startsWith("sub-aggregate")
          expect(Exit.isSuccess(create) && json(create.value)).toBe(
            json(sub ? { id: "a", part: { lines } } : { id: "a", lines }),
          )
          expect(rows.filter((row) => row.__edd_e__?.S === "SheetLine")).toHaveLength(1)
          expect(Exit.isSuccess(get) && json(get.value)).toBe(
            json((create as Exit.Success<unknown>).value),
          )
        }),
      )
    }

    for (const [label, code] of [
      ["one, an entity keyed by a number, given a numeric string", "[EDD-9131]"],
      ["one and one, the second an entity keyed by two composites", "[EDD-9129]"],
      ...Object.keys(UNKEYABLE).map((label) => [label, "[EDD-9131]"] as const),
      ...Object.keys(UNSTORABLE).map((label) => [label, "[EDD-9131]"] as const),
    ] as const) {
      it.effect(`${label}: create fails with ${code}, nothing written`, () =>
        Effect.gen(function* () {
          const { create, rows } = yield* run(SHAPES[label]!())
          expect(refusal(create)).toContain(code)
          expect(byKey(rows)).toEqual(byKey(fixture.shapes[label]!.seeded))
        }),
      )
    }
  },
)
