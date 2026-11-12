/**
 * A time-series `orderBy` stored as a type DynamoDB's `<` doesn't take, against DynamoDB Local
 * (#242, `EDD-9163`): the connected twin of `OrderByOperandType.test.ts`.
 *
 * An append guards its write with `#_tsob < :_tsNewOb`. Through 1.40.0 an `orderBy` stored as a
 * map (an `Option`, a `Result`, a `Duration`, a `BigDecimal`, a named or an offset zone), a
 * list or a boolean made DynamoDB refuse every append of the entity, and a null the appends
 * holding it, with a bare `DynamoValidationError`. Each is now a `ValidationError` naming
 * `orderBy`, the field and the type, DynamoDB's error its cause, and nothing is written. A
 * struct is refused before sending, as an object composed into the event's sort key
 * (`EDD-9162`). A date, a `Schema.DurationFromMillis`, a number, a literal or a `Redacted`
 * string (stored as a number or a string) append as they did.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  ScanCommand,
} from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import {
  BigDecimal,
  Config,
  DateTime,
  Duration,
  Effect,
  Option,
  Redacted,
  Result,
  Schema,
} from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

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
const schema = DynamoSchema.make({ name: "obot", version: 1 })

/** A time-series entity whose `orderBy` is `seq` of `seqSchema`, stored as `field` if given. */
const entityOf = (seqSchema: Schema.Top, field?: string) => {
  const Model = Schema.Struct({ id: Schema.String, seq: seqSchema })
  return Entity.make({
    model: field === undefined ? Model : DynamoModel.configure(Model, { seq: { field } }),
    entityType: "Reading",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
    timeSeries: { orderBy: "seq", appendInput: Model },
  } as never) as any
}

/**
 * Append each value in turn to a fresh table: each outcome, and the rows left. A value given as
 * `{ seq, condition }` appends with that condition of the caller's.
 */
const appendEach = (Readings: any, values: ReadonlyArray<unknown>) => {
  const TableName = `orderby-operand-type-${Date.now()}-${tables++}`
  const Main = Table.make({ schema, entities: { Readings } })
  return Effect.gen(function* () {
    yield* send(() =>
      raw.send(
        new CreateTableCommand({
          TableName,
          BillingMode: "PAY_PER_REQUEST",
          AttributeDefinitions: [
            { AttributeName: "pk", AttributeType: "S" },
            { AttributeName: "sk", AttributeType: "S" },
          ],
          KeySchema: [
            { AttributeName: "pk", KeyType: "HASH" },
            { AttributeName: "sk", KeyType: "RANGE" },
          ],
        }),
      ),
    )
    const outcomes = yield* Effect.gen(function* () {
      const db: any = yield* DynamoClient.make({
        entities: { Readings },
        tables: { Main },
      } as never)
      const results: Array<unknown> = []
      for (const value of values) {
        const conditioned = value instanceof Conditioned ? value : undefined
        const append = db.entities.Readings.append({ id: "r1", seq: conditioned?.seq ?? value })
        results.push(
          yield* (conditioned === undefined ? append : append.condition(conditioned.condition))
            .asEffect()
            .pipe(
              Effect.as("appended"),
              Effect.catch((error: unknown) => Effect.succeed(error)),
            ),
        )
      }
      return results
    }).pipe(Effect.provide(Main.layer({ name: TableName })), Effect.provide(ClientLayer))
    const rows = yield* send(() => raw.send(new ScanCommand({ TableName })))
    return { outcomes, rows: rows.Items ?? [] }
  }).pipe(
    Effect.ensuring(Effect.ignore(send(() => raw.send(new DeleteTableCommand({ TableName }))))),
  ) as Effect.Effect<{ outcomes: Array<any>; rows: Array<unknown> }>
}

/** An append's `orderBy` value with a condition of the caller's. */
class Conditioned {
  constructor(
    readonly seq: unknown,
    readonly condition: (t: any, ops: any) => unknown,
  ) {}
}

/** `EDD-9163` naming `orderBy`, its field and the type, DynamoDB's refusal one step down. */
const expectRefused = (outcome: any, type: string, field = "seq") => {
  expect(outcome?._tag).toBe("ValidationError")
  expect(outcome.operation).toBe("append")
  const message = String(outcome.cause?.message)
  expect(message).toContain("[EDD-9163]")
  expect(message).toContain(`timeSeries.orderBy field "${field}"`)
  expect(message).toContain(type)
  expect(outcome.cause?.cause?._tag).toBe("DynamoValidationError")
}

/** Each kind DynamoDB refuses: its schema, two values in order, the type it's stored as. */
const refused: Record<
  string,
  { readonly schema: Schema.Top; readonly values: () => [unknown, unknown]; readonly type: string }
> = {
  Option: {
    schema: Schema.Option(Schema.Number),
    values: () => [Option.some(1), Option.some(2)],
    type: "a map (M)",
  },
  "Result (Either's successor)": {
    schema: Schema.Result(Schema.Number, Schema.String),
    values: () => [Result.succeed(1), Result.succeed(2)],
    type: "a map (M)",
  },
  Duration: {
    schema: Schema.Duration,
    values: () => [Duration.millis(1), Duration.millis(2)],
    type: "a map (M)",
  },
  BigDecimal: {
    schema: Schema.BigDecimal,
    values: () => [BigDecimal.fromStringUnsafe("1"), BigDecimal.fromStringUnsafe("2")],
    type: "a map (M)",
  },
  "named zone": {
    schema: Schema.TimeZoneNamed,
    values: () => [
      DateTime.zoneMakeNamedUnsafe("Europe/London"),
      DateTime.zoneMakeNamedUnsafe("Europe/Paris"),
    ],
    type: "a map (M)",
  },
  "offset zone": {
    schema: Schema.TimeZoneOffset,
    values: () => [DateTime.zoneMakeOffset(0), DateTime.zoneMakeOffset(3_600_000)],
    type: "a map (M)",
  },
  boolean: { schema: Schema.Boolean, values: () => [false, true], type: "a boolean (BOOL)" },
  list: {
    schema: Schema.Array(Schema.Number),
    values: () => [[1], [2]],
    type: "a list (L)",
  },
}

/** Each kind stored as a number or a string: two values in order. */
const appended: Record<string, { readonly schema: Schema.Top; readonly values: () => unknown[] }> =
  {
    DateTimeZoned: {
      schema: Schema.DateTimeZoned,
      values: () => [
        DateTime.makeZonedUnsafe(0, { timeZone: "Europe/London" }),
        DateTime.makeZonedUnsafe(1, { timeZone: "Europe/London" }),
      ],
    },
    DurationFromMillis: {
      schema: Schema.DurationFromMillis,
      values: () => [Duration.millis(1), Duration.millis(2)],
    },
    number: { schema: Schema.Number, values: () => [1, 2] },
    literal: { schema: Schema.Literals(["a", "b"]), values: () => ["a", "b"] },
    "Redacted string": {
      schema: Schema.Redacted(Schema.String),
      values: () => [Redacted.make("a"), Redacted.make("b")],
    },
  }

describeConnected("an append whose orderBy is stored as a type < doesn't take (EDD-9163)", () => {
  for (const [name, kind] of Object.entries(refused)) {
    it.effect(`${name}: every append is a ValidationError naming orderBy, nothing written`, () =>
      Effect.gen(function* () {
        const { outcomes, rows } = yield* appendEach(entityOf(kind.schema), kind.values())
        for (const outcome of outcomes) expectRefused(outcome, kind.type)
        expect(rows).toHaveLength(0)
      }),
    )
  }

  it.effect("a renamed orderBy is named by its model field", () =>
    Effect.gen(function* () {
      const { outcomes, rows } = yield* appendEach(
        entityOf(Schema.Option(Schema.Number), "observedAt"),
        [Option.some(1)],
      )
      expectRefused(outcomes[0], "a map (M)")
      expect(rows).toHaveLength(0)
    }),
  )

  it.effect("a null orderBy refuses the append holding it; a number then appends", () =>
    Effect.gen(function* () {
      const { outcomes, rows } = yield* appendEach(entityOf(Schema.NullOr(Schema.Number)), [
        null,
        2,
      ])
      expectRefused(outcomes[0], "null (NULL)")
      expect(outcomes[1]).toBe("appended")
      // The current item and the one event.
      expect(rows).toHaveLength(2)
    }),
  )

  it.effect("a struct is refused before sending, as an object composed into a key (EDD-9162)", () =>
    Effect.gen(function* () {
      const { outcomes, rows } = yield* appendEach(entityOf(Schema.Struct({ a: Schema.Number })), [
        { a: 1 },
      ])
      expect(outcomes[0]?._tag).toBe("ValidationError")
      expect(String(outcomes[0]?.cause?.message ?? outcomes[0]?.message)).toContain("[EDD-9162]")
      expect(rows).toHaveLength(0)
    }),
  )

  for (const [name, kind] of Object.entries(appended)) {
    it.effect(`${name}: appends as it did`, () =>
      Effect.gen(function* () {
        const { outcomes, rows } = yield* appendEach(entityOf(kind.schema), kind.values())
        expect(outcomes).toEqual(["appended", "appended"])
        expect(rows).toHaveLength(3)
      }),
    )
  }
})

describeConnected("the caller's own condition is DynamoDB's to refuse (not EDD-9163)", () => {
  /** DynamoDB's refusal of a comparison, passed through as 1.40.0 gave it. */
  const expectDynamo = (outcome: any, operator: string, type: string) => {
    expect(outcome?._tag).toBe("DynamoValidationError")
    const message = String(outcome?.cause?.message)
    expect(message).not.toContain("EDD-9163")
    expect(message).toContain(`operator or function: ${operator}, operand type: ${type}`)
  }
  for (const [name, operator, type, condition] of [
    ["null", "<", "NULL", (t: any, { lt }: any) => lt(t.seq, null)],
    ["a map", "<", "M", (t: any, { lt }: any) => lt(t.seq, { a: 1 })],
    ["a boolean", ">", "BOOL", (t: any, { gt }: any) => gt(t.seq, true)],
    ["a list", "<", "L", (t: any, { lt }: any) => lt(t.seq, [1])],
  ] as const) {
    it.effect(`comparing the orderBy with ${name}: first append, then on the item`, () =>
      Effect.gen(function* () {
        const { outcomes, rows } = yield* appendEach(entityOf(Schema.Number), [
          new Conditioned(1, condition),
          1,
          new Conditioned(2, condition),
        ])
        expectDynamo(outcomes[0], operator, type)
        expect(outcomes[1]).toBe("appended")
        expectDynamo(outcomes[2], operator, type)
        // The one append that went through: the current item and its event.
        expect(rows).toHaveLength(2)
      }),
    )
  }

  it.effect("comparing the orderBy with another type is a condition that doesn't hold", () =>
    Effect.gen(function* () {
      const condition = (t: any, { lt }: any) => lt(t.seq, "x")
      const { outcomes, rows } = yield* appendEach(entityOf(Schema.Number), [
        new Conditioned(1, condition),
        1,
        new Conditioned(2, condition),
      ])
      expect(outcomes[0]?._tag).toBe("ConditionalCheckFailed")
      expect(outcomes[1]).toBe("appended")
      expect(outcomes[2]?._tag).toBe("ConditionalCheckFailed")
      expect(rows).toHaveLength(2)
    }),
  )

  it.effect(
    "a nullable orderBy: the caller's null is DynamoDB's, the append's own is EDD-9163",
    () =>
      Effect.gen(function* () {
        const callers = (t: any, { lt }: any) => lt(t.seq, null)
        const { outcomes, rows } = yield* appendEach(entityOf(Schema.NullOr(Schema.Number)), [
          new Conditioned(1, callers),
          null,
          1,
          new Conditioned(2, callers),
        ])
        expectDynamo(outcomes[0], "<", "NULL")
        expectRefused(outcomes[1], "null (NULL)")
        expect(outcomes[2]).toBe("appended")
        expectDynamo(outcomes[3], "<", "NULL")
        expect(rows).toHaveLength(2)
      }),
  )
})
