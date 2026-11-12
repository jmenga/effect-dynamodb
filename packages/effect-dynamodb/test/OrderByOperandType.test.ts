/**
 * A time-series `orderBy` stored as a type DynamoDB's `<` doesn't take (#242, `EDD-9163`).
 *
 * An append guards its write with `#_tsob < :_tsNewOb`. An `orderBy` stored as a map (an
 * `Option`, a `Result`, a `Duration`, a `BigDecimal`, a zone), a list, a boolean or null makes
 * DynamoDB refuse that condition whatever the item holds. Nothing refuses the entity at
 * `make` and nothing is checked before sending: the append is sent, and DynamoDB's refusal,
 * confirmed against the condition sent, becomes a `ValidationError` naming the field, with
 * DynamoDB's error as its cause. The diagnosis is opt-in: a write that doesn't ask for it (a
 * `put`) passes DynamoDB's refusal through as it always did.
 */
import type { TransactWriteItemsInput } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import {
  DynamoError,
  DynamoValidationError,
  type ValidationError,
} from "@effect-dynamodb/schema/Errors.js"
import { Effect, Layer, Option, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import {
  awsTransactionCanceled,
  awsValidationException,
  ddbOperandType,
  mockDynamoClientLayer,
} from "./helpers/MockDynamoClient.js"

const AppSchema = DynamoSchema.make({ name: "edd9163", version: 1 })

const Reading = Schema.Struct({
  id: Schema.String,
  observed: Schema.Option(Schema.Number),
  flag: Schema.optional(Schema.Option(Schema.Number)),
})
const ReadingInput = Schema.Struct({ id: Schema.String, observed: Schema.Option(Schema.Number) })

const primaryKey = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
} as const

/** `orderBy` is an `Option`: stored as a map. */
const Readings = Entity.make({
  model: Reading,
  entityType: "Reading",
  primaryKey,
  timeSeries: { orderBy: "observed", appendInput: ReadingInput },
})

/** The same, its `orderBy` stored under another name. */
const Renamed = Entity.make({
  model: DynamoModel.configure(Reading, { observed: { field: "observedAt" } }),
  entityType: "Renamed",
  primaryKey,
  timeSeries: { orderBy: "observed", appendInput: ReadingInput },
})

/** `orderBy` is a number, so its guard compares numbers; `flag` is a map. */
const Counter = Schema.Struct({
  id: Schema.String,
  n: Schema.Number,
  flag: Schema.optional(Schema.Option(Schema.Number)),
})
const Counts = Entity.make({
  model: Counter,
  entityType: "Count",
  primaryKey,
  timeSeries: {
    orderBy: "n",
    appendInput: Schema.Struct({ id: Schema.String, n: Schema.Number }),
  },
})

const Main = Table.make({ schema: AppSchema, entities: { Readings, Renamed, Counts } })

/** What DynamoDB answers every write with, and the transactions sent. */
const refusing = (failure: () => unknown) => {
  const sent: Array<TransactWriteItemsInput> = []
  const layer = Layer.merge(
    mockDynamoClientLayer({
      transactWriteItems: (input) => {
        sent.push(input)
        return Effect.fail(failure() as DynamoError)
      },
      putItem: () => Effect.fail(failure() as DynamoError),
    }),
    Main.layer({ name: "edd9163" }),
  )
  return { sent, layer }
}

const requestRefusal = (operator: string, type: string) => () =>
  new DynamoValidationError({
    operation: "TransactWriteItems",
    cause: awsValidationException(ddbOperandType(operator, type)),
  })

const client = DynamoClient.make({ entities: { Readings, Renamed, Counts }, tables: { Main } })

/** The `ValidationError`'s readable message, then DynamoDB's error under it. */
const causes = (error: ValidationError) => {
  const readable = error.cause as Error & { readonly cause?: unknown }
  return { message: readable.message, dynamo: readable.cause as { readonly _tag?: string } }
}

describe("an append whose orderBy is stored as a type < doesn't take (EDD-9163)", () => {
  it.effect("is a ValidationError naming orderBy and its field, DynamoDB's error the cause", () => {
    const { sent, layer } = refusing(requestRefusal("<", "M"))
    return Effect.gen(function* () {
      const db = yield* client
      const error = yield* db.entities.Readings.append({ id: "r1", observed: Option.some(1) })
        .asEffect()
        .pipe(Effect.flip)
      expect(error._tag).toBe("ValidationError")
      const failed = error as ValidationError
      expect(failed.operation).toBe("append")
      expect(failed.entityType).toBe("Reading")
      const { message, dynamo } = causes(failed)
      expect(message).toContain("[EDD-9163]")
      expect(message).toContain('timeSeries.orderBy field "observed"')
      expect(message).toContain("a map (M)")
      expect(message).toContain("Nothing was written")
      expect(dynamo._tag).toBe("DynamoValidationError")
      // Sent once: the refusal is terminal, never taken for a stale append.
      expect(sent).toHaveLength(1)
      expect(sent[0]!.TransactItems?.[0]?.Update?.ConditionExpression).toContain("#_tsob <")
    }).pipe(Effect.provide(layer))
  })

  it.effect("names the model field when its attribute is renamed", () => {
    const { layer } = refusing(requestRefusal("<", "M"))
    return Effect.gen(function* () {
      const db = yield* client
      const error = yield* db.entities.Renamed.append({ id: "r1", observed: Option.some(1) })
        .asEffect()
        .pipe(Effect.flip)
      const { message } = causes(error as ValidationError)
      expect(message).toContain('[EDD-9163] Entity "Renamed"')
      expect(message).toContain('timeSeries.orderBy field "observed"')
    }).pipe(Effect.provide(layer))
  })

  it.effect("is the same refusal in a cancellation reason at the current item", () => {
    const { layer } = refusing(
      () =>
        new DynamoError({
          operation: "TransactWriteItems",
          cause: awsTransactionCanceled([
            { Code: "ValidationError", Message: ddbOperandType("<", "M") },
            { Code: "None" },
          ]),
        }),
    )
    return Effect.gen(function* () {
      const db = yield* client
      const error = yield* db.entities.Readings.append({ id: "r1", observed: Option.some(1) })
        .asEffect()
        .pipe(Effect.flip)
      expect(error._tag).toBe("ValidationError")
      expect(causes(error as ValidationError).message).toContain("[EDD-9163]")
    }).pipe(Effect.provide(layer))
  })

  it.effect("passes a refusal the condition sent doesn't confirm through unchanged", () => {
    // DynamoDB names a list; the condition compares a map.
    const { layer } = refusing(requestRefusal("<", "L"))
    return Effect.gen(function* () {
      const db = yield* client
      const error = yield* db.entities.Readings.append({ id: "r1", observed: Option.some(1) })
        .asEffect()
        .pipe(Effect.flip)
      expect(error._tag).toBe("DynamoValidationError")
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    "passes the caller's own refused comparison of another attribute through unchanged",
    () => {
      const { layer } = refusing(requestRefusal("<", "M"))
      return Effect.gen(function* () {
        const db = yield* client
        const error = yield* db.entities.Counts.append({ id: "c1", n: 1 })
          .condition((t, { lt }) => lt(t.flag as never, Option.some(1) as never))
          .asEffect()
          .pipe(Effect.flip)
        expect(error._tag).toBe("DynamoValidationError")
      }).pipe(Effect.provide(layer))
    },
  )

  // The caller's condition compares the orderBy field itself with a value `<` doesn't take: the
  // diagnosis names the orderBy attribute, but the guard's own operand is a number, so the append
  // value isn't what DynamoDB refused. DynamoDB's error, as 1.40.0 gave it.
  for (const [name, type, condition] of [
    ["null", "NULL", (t: any, { lt }: any) => lt(t.n, null)],
    ["a map", "M", (t: any, { lt }: any) => lt(t.n, { a: 1 })],
    ["a boolean", "BOOL", (t: any, { gt }: any) => gt(t.n, true)],
  ] as const) {
    it.effect(
      `passes the caller's comparison of the orderBy with ${name} through unchanged`,
      () => {
        const operator = name === "a boolean" ? ">" : "<"
        const { sent, layer } = refusing(requestRefusal(operator, type))
        return Effect.gen(function* () {
          const db = yield* client
          const error = yield* db.entities.Counts.append({ id: "c1", n: 1 })
            .condition(condition as never)
            .asEffect()
            .pipe(Effect.flip)
          expect(error._tag).toBe("DynamoValidationError")
          expect(String((error as { cause?: { message?: string } }).cause?.message)).toContain(
            `operand type: ${type}`,
          )
          expect(
            sent[0]!.TransactItems?.[0]?.Update?.ExpressionAttributeValues?.[":_tsNewOb"],
          ).toEqual({
            N: "1",
          })
        }).pipe(Effect.provide(layer))
      },
    )
  }

  it.effect("leaves a write that doesn't ask for the diagnosis as DynamoDB refused it", () => {
    const { layer } = refusing(
      () =>
        new DynamoValidationError({
          operation: "PutItem",
          cause: awsValidationException(ddbOperandType("<", "M")),
        }),
    )
    return Effect.gen(function* () {
      const db = yield* client
      const error = yield* db.entities.Readings.put({ id: "r1", observed: Option.some(1) })
        .condition((t, { lt }) => lt(t.observed as never, Option.some(2) as never))
        .asEffect()
        .pipe(Effect.flip)
      expect(error._tag).toBe("DynamoValidationError")
    }).pipe(Effect.provide(layer))
  })
})
