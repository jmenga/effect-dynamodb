/**
 * A condition's or filter's operand that is one of Effect's instances, compared by DynamoDB Local
 * with the attribute a row holds (#242, `operandsAsStored`): the connected twin of
 * `OperandsAsStored.test.ts`. Through 1.40.0 such an operand was sent as the instance's map, so on
 * a field that stores the value another way (ISO text for a `DateTime`, a number for a
 * `DurationFromMillis`, the secret for a `Redacted`) an equality never matched and a condition
 * always failed. Now each comparator, `between`, `isIn` and `contains`, an update's and a delete's
 * condition, a transaction's, a collection's filter and an aggregate's `list` filter compare what
 * the row holds. A zone, a `Duration` and an `Option` stored as their map match as they did.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, DateTime, Duration, Effect, Exit, Option, Redacted, Schema } from "effect"
import { describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"

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
const schema = DynamoSchema.make({ name: "oas", version: 1 })

/** A fresh table with `gsi1`, dropped after `body`. */
const withTable = <A>(body: (name: string) => Effect.Effect<A, unknown, any>) => {
  const TableName = `operands-as-stored-${Date.now()}-${tables++}`
  return Effect.gen(function* () {
    yield* send(() =>
      raw.send(
        new CreateTableCommand({
          TableName,
          BillingMode: "PAY_PER_REQUEST",
          AttributeDefinitions: [
            { AttributeName: "pk", AttributeType: "S" },
            { AttributeName: "sk", AttributeType: "S" },
            { AttributeName: "gsi1pk", AttributeType: "S" },
            { AttributeName: "gsi1sk", AttributeType: "S" },
          ],
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
        }),
      ),
    )
    return yield* body(TableName)
  }).pipe(
    Effect.ensuring(Effect.ignore(send(() => raw.send(new DeleteTableCommand({ TableName }))))),
  ) as Effect.Effect<A, unknown>
}

const bound = <A>(
  name: string,
  Main: any,
  members: {
    readonly entities?: Record<string, unknown>
    readonly aggregates?: Record<string, unknown>
  },
  body: (db: any) => Effect.Effect<A, unknown, any>,
) =>
  Effect.gen(function* () {
    const db = yield* DynamoClient.make({
      entities: members.entities ?? {},
      aggregates: members.aggregates ?? {},
      tables: { Main },
    } as never)
    return yield* body(db)
  }).pipe(Effect.provide(Main.layer({ name })), Effect.provide(ClientLayer)) as Effect.Effect<
    A,
    unknown
  >

const zoned = (ms: number) => DateTime.makeZonedUnsafe(ms, { timeZone: "Europe/London" })

/** Each kind: its schema, the value written, one below and one above it (for `between`), or none. */
const kinds: Record<
  string,
  {
    readonly schema: Schema.Top
    readonly make: () => unknown
    readonly around?: readonly [() => unknown, () => unknown]
  }
> = {
  DateTimeUtc: {
    schema: Schema.DateTimeUtc,
    make: () => DateTime.makeUnsafe(60_000),
    around: [() => DateTime.makeUnsafe(0), () => DateTime.makeUnsafe(120_000)],
  },
  "DateTimeZoned named": {
    schema: Schema.DateTimeZoned,
    make: () => zoned(60_000),
    around: [() => zoned(0), () => zoned(120_000)],
  },
  "DateTimeZoned offset": {
    schema: Schema.DateTimeZoned,
    make: () => DateTime.makeZonedUnsafe(0, { timeZone: DateTime.zoneMakeOffset(3_600_000) }),
  },
  Redacted: { schema: Schema.Redacted(Schema.String), make: () => Redacted.make("s") },
  DurationFromMillis: {
    schema: Schema.DurationFromMillis,
    make: () => Duration.millis(1500),
    around: [() => Duration.millis(1000), () => Duration.millis(2000)],
  },
  "TimeZone named (stored as its map, as before)": {
    schema: Schema.TimeZoneNamed,
    make: () => DateTime.zoneMakeNamedUnsafe("Europe/London"),
  },
  "Duration (stored as its map, as before)": {
    schema: Schema.Duration,
    make: () => Duration.millis(1500),
  },
  "Option (stored as its map, as before)": {
    schema: Schema.Option(Schema.Number),
    make: () => Option.some(1),
  },
}

describeConnected("an operand that is one of Effect's instances, against DynamoDB Local", () => {
  for (const [name, kind] of Object.entries(kinds)) {
    it.effect(name, () =>
      withTable((table) => {
        const E = Entity.make({
          model: Schema.Struct({
            id: Schema.String,
            f: Schema.optional(kind.schema),
            fs: Schema.optional(Schema.Array(kind.schema)),
            n: Schema.optional(Schema.String),
          }),
          entityType: "E",
          primaryKey: {
            pk: { field: "pk", composite: ["id"] },
            sk: { field: "sk", composite: [] },
          },
        } as never) as any
        const Main = Table.make({ schema, entities: { E } })
        return bound(table, Main, { entities: { E } }, (db) =>
          Effect.gen(function* () {
            yield* db.entities.E.put({ id: "a", f: kind.make(), fs: [kind.make()] }).asEffect()
            const count = (filter: (t: any, ops: any) => unknown) =>
              Effect.map(
                db.entities.E.scan().filter(filter).collect(),
                (items: any) => items.length,
              )
            expect(yield* count((t, { eq }) => eq(t.f, kind.make()))).toBe(1)
            expect(
              yield* Effect.map(
                db.entities.E.scan().filter({ f: kind.make() }).collect(),
                (items: any) => items.length,
              ),
            ).toBe(1)
            expect(yield* count((t, { ne }) => ne(t.f, kind.make()))).toBe(0)
            expect(yield* count((t, { isIn }) => isIn(t.f, [kind.make()]))).toBe(1)
            expect(yield* count((t, { contains }) => contains(t.fs, kind.make()))).toBe(1)
            if (kind.around !== undefined) {
              const [below, above] = kind.around
              expect(yield* count((t, { between }) => between(t.f, below(), above()))).toBe(1)
              expect(yield* count((t, { gt }) => gt(t.f, below()))).toBe(1)
              expect(yield* count((t, { lt }) => lt(t.f, below()))).toBe(0)
            }
            // Conditions: an update's (callback and shorthand), a transaction's, a delete's.
            yield* db.entities.E.update({ id: "a" })
              .set({ n: "x" })
              .condition((t: any, { eq }: any) => eq(t.f, kind.make()))
              .asEffect()
            yield* db.entities.E.update({ id: "a" })
              .set({ n: "y" })
              .condition({ f: kind.make() })
              .asEffect()
            yield* Transaction.transactWrite([
              db.entities.E.update({ id: "a" }).set({ n: "z" }).condition({ f: kind.make() }),
            ])
            expect((yield* db.entities.E.get({ id: "a" })).n).toBe("z")
            yield* db.entities.E.delete({ id: "a" }).condition({ f: kind.make() }).asEffect()
            expect(Exit.isFailure(yield* Effect.exit(db.entities.E.get({ id: "a" })))).toBe(true)
          }),
        )
      }),
    )
  }

  it.effect("a collection's filter, members holding the operand alike and not", () =>
    withTable((table) => {
      const member = (entityType: string, at: Schema.Top) =>
        Entity.make({
          model: Schema.Struct({ owner: Schema.String, id: Schema.String, at }),
          entityType,
          primaryKey: {
            pk: { field: "pk", composite: ["id"] },
            sk: { field: "sk", composite: [] },
          },
          indexes: {
            byOwner: {
              name: "gsi1",
              collection: "owned",
              pk: { field: "gsi1pk", composite: ["owner"] },
              sk: { field: "gsi1sk", composite: [] },
            },
          },
        } as never) as any
      const A = member("A", Schema.DateTimeZoned)
      const B = member("B", Schema.DateTimeZoned)
      const C = member("C", Schema.Unknown)
      const Main = Table.make({ schema, entities: { A, B, C } })
      return bound(table, Main, { entities: { A, B, C } }, (db) =>
        Effect.gen(function* () {
          for (const [entity, id] of [
            ["A", "a"],
            ["B", "b"],
            ["C", "c"],
          ] as const) {
            yield* db.entities[entity].put({ owner: "o", id, at: zoned(0) }).asEffect()
          }
          const found = yield* db.collections
            .owned({ owner: "o" })
            .filter({ at: zoned(0) })
            .collect()
          expect([found.A.length, found.B.length, found.C.length]).toEqual([1, 1, 1])
          const none = yield* db.collections
            .owned({ owner: "o" })
            .filter({ at: zoned(1) })
            .collect()
          expect([none.A.length, none.B.length, none.C.length]).toEqual([0, 0, 0])
        }),
      )
    }),
  )

  it.effect("an aggregate's list filter on a root field", () =>
    withTable((table) => {
      const Anchors = Entity.make({
        model: Schema.Struct({ anchorId: Schema.String }),
        entityType: "Anchor",
        primaryKey: {
          pk: { field: "pk", composite: ["anchorId"] },
          sk: { field: "sk", composite: [] },
        },
      })
      const Main = Table.make({ schema, entities: { Anchors } })
      const Matches = Aggregate.make(
        Schema.Struct({
          id: Schema.String,
          tournament: Schema.String,
          when: Schema.DateTimeZoned,
          d: Schema.DurationFromMillis,
        }),
        {
          table: Main,
          schema,
          pk: { field: "pk", composite: ["id"] },
          collection: { name: "match" },
          list: {
            index: "gsi1",
            name: "matchlist",
            pk: { field: "gsi1pk", composite: ["tournament"] },
            sk: { field: "gsi1sk", composite: ["id"] },
          },
          root: { entityType: "MatchItem" },
          edges: {},
        } as never,
      ) as any
      return bound(table, Main, { entities: { Anchors }, aggregates: { Matches } }, (db) =>
        Effect.gen(function* () {
          yield* db.aggregates.Matches.create({
            id: "m",
            tournament: "t",
            when: zoned(0),
            d: Duration.millis(1500),
          })
          const list = (filter: unknown) =>
            Effect.map(
              db.aggregates.Matches.list({ tournament: "t" }, { filter }),
              (result: any) => result.data.length,
            )
          expect(yield* list({ when: zoned(0) })).toBe(1)
          expect(yield* list({ d: Duration.millis(1500) })).toBe(1)
          expect(yield* list((t: any, { eq }: any) => eq(t.when, zoned(0)))).toBe(1)
          expect(yield* list({ when: zoned(1) })).toBe(0)
        }),
      )
    }),
  )
})
