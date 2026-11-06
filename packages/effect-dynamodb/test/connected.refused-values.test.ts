/**
 * Values the library can't compose or send, against DynamoDB Local: on every path, under both
 * `escapeKeys` settings, a `ValidationError` and an empty table.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { DynamoDBClient, PutItemCommand, ScanCommand } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Effect, Layer, Schema } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import * as RefusedValues from "./helpers/RefusedValues.js"

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

let tables = 0
const rowsOf = (tableName: string) =>
  Effect.promise(async () => {
    const { Items = [] } = await raw.send(
      new ScanCommand({ TableName: tableName, ConsistentRead: true }),
    )
    return Items
  })

/** `body` on a fresh table of `MainTable`'s definition. */
const onTable = <A, E>(
  MainTable: any,
  Base: any,
  body: (tableName: string) => Effect.Effect<A, E, any>,
) => {
  const tableName = `refused-${Date.now()}-${tables++}`
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const client = yield* DynamoClient
      yield* client.createTable({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        ...Table.definition(MainTable),
      })
    }),
    () => body(tableName),
    () =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(Effect.ignore),
  ).pipe(
    Effect.provide(Layer.merge(ClientLayer, Base.layer({ name: tableName }) as Layer.Layer<never>)),
  ) as Effect.Effect<A, unknown>
}

describeConnected("values that can't be stored, on DynamoDB", () => {
  describe.each(RefusedValues.SETTINGS)("escapeKeys %s", (_name, on) => {
    const w = RefusedValues.refusedWorld(on)
    const each = (
      cases: ReadonlyArray<
        readonly [string, (client: any) => Effect.Effect<unknown, unknown, any>]
      >,
      tag: string,
      code: string,
    ) => {
      for (const [name, run] of cases) {
        it.effect(name, () =>
          onTable(w.MainTable, w.Base, (tableName) =>
            Effect.gen(function* () {
              const client = yield* w.client as Effect.Effect<any>
              yield* RefusedValues.expectRefused(
                Effect.suspend(() => run(client)),
                tag,
                code,
              )
              expect(yield* rowsOf(tableName)).toEqual([])
            }),
          ),
        )
      }
    }

    describe("[EDD-9096] NaN as a key", () => {
      each(RefusedValues.keyCases(w, Number.NaN), "KeyValueError", "[EDD-9096]")
    })
    describe("[EDD-9124] NaN as a value", () => {
      each(RefusedValues.valueCases(w, Number.NaN), "UnstorableValueError", "[EDD-9124]")
    })
    describe("[EDD-9124] Infinity as a value", () => {
      each(
        RefusedValues.valueCases(w, Number.POSITIVE_INFINITY),
        "UnstorableValueError",
        "[EDD-9124]",
      )
    })

    it.effect("a row 1.36 stored under NaN's text is scanned, and rekey leaves it", () => {
      const Readings = Entity.make({
        model: Schema.Struct({ id: Schema.String, level: Schema.NumberFromString }),
        entityType: "Reading",
        primaryKey: {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: ["level"] },
        },
      })
      const Readers = Table.make({
        schema: DynamoSchema.make({ name: "nan136", version: 1, escapeKeys: on }),
        entities: { Readings },
      })
      return onTable(Readers, Readers, (tableName) =>
        Effect.gen(function* () {
          const db = yield* DynamoClient.make({ entities: { Readings }, tables: { Readers } })
          const row = toAttributeMap({
            pk: "$nan136#v1#reading#id_a",
            sk: "$nan136#v1#reading#level_0000000000000nan",
            __edd_e__: "Reading",
            id: "a",
            level: "NaN",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          })
          yield* Effect.promise(() =>
            raw.send(new PutItemCommand({ TableName: tableName, Item: row })),
          )
          const scanned = yield* db.entities.Readings.scan().collect()
          expect(scanned.map((reading) => Number.isNaN(reading.level))).toEqual([true])
          const report = yield* db.tables.Readers.rekey()
          expect(report.skipped.unrecognizedKey).toBe(1)
          expect(report.moved.item).toBe(0)
          expect(report.indexKeysRewritten).toBe(0)
          expect(yield* rowsOf(tableName)).toEqual([row])
        }),
      )
    })

    it.effect("a bigint past the numeric text's limit, as DynamoDB takes it", () => {
      const long = 10n ** 1000n
      const Bigs = Entity.make({
        model: Schema.Struct({ id: Schema.String, n: Schema.BigInt, s: Schema.BigIntFromString }),
        entityType: "Big",
        primaryKey: {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: ["s"] },
        },
      })
      const Readers = Table.make({
        schema: DynamoSchema.make({ name: "bigs", version: 1, escapeKeys: on }),
        entities: { Bigs },
      })
      return onTable(Readers, Readers, () =>
        Effect.gen(function* () {
          const db = yield* DynamoClient.make({ entities: { Bigs }, tables: { Readers } })
          // As a number attribute, past what DynamoDB holds: DynamoDB's own refusal.
          const overflow: any = yield* Effect.flip(
            db.entities.Bigs.put({ id: "a", s: 1n, n: long }).asEffect(),
          )
          expect(overflow._tag).toBe("DynamoValidationError")
          // As a key, a string: 1.36's text under off, and refused under on.
          const keyed = Effect.exit(db.entities.Bigs.put({ id: "a", s: long, n: 1n }).asEffect())
          const exit = yield* keyed
          if (on) {
            expect(exit._tag).toBe("Failure")
          } else {
            expect(exit._tag).toBe("Success")
          }
        }),
      )
    })
  })
})
