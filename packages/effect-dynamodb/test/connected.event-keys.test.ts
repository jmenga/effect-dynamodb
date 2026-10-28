/**
 * #171 F2 / E9 against DynamoDB Local: a time-series entity whose `orderBy` is
 * a string-encoded number (`NumberFromString`, `BigIntFromString`), stored as
 * `S`.
 *
 * - F2: event keys hold the orderBy's numeric key text, so `.history()` reads
 *   events in numeric order and every `.where()` operator returns the events
 *   it means, forward and reverse. Up to 1.36 they held the encoded text
 *   (`10` sorted before `9`).
 * - E9: DynamoDB compares `S` as text, so the `<` CAS refused `10` after `9`.
 *   The append reads the current item, compares the numbers and guards the
 *   write on the stored value: increasing appends apply, an older or equal
 *   one is `StaleAppend` and writes no event, concurrent appends settle on
 *   the greatest, and the user's condition still decides.
 * - Every `orderBy` type (`Number` and a string too): a transaction cancelled
 *   for a `TransactionConflict` alone — injected, as DynamoDB Local never
 *   raises one — is sent again and applies, and a user condition rejecting
 *   the append that would create the item is `ConditionalCheckFailed` with no
 *   current item (#171 G5).
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import { Config, Effect, Layer, Option, Schema } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import { DynamoClient, type DynamoClientService } from "../src/DynamoClient.js"
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

const AppSchema = DynamoSchema.make({ name: "event-keys", version: 1 })
const tableName = `event-keys-${Date.now()}`

const makeMeters = <S extends Schema.Top>(seq: S, entityType = "Reading") => {
  const Reading = Schema.Struct({
    site: Schema.String,
    meter: Schema.String,
    seq,
    note: Schema.String,
  })
  return Entity.make({
    model: Reading,
    entityType,
    primaryKey: {
      pk: { field: "pk", composite: ["site"] },
      sk: { field: "sk", composite: ["meter"] },
    },
    timeSeries: { orderBy: "seq", appendInput: Reading },
  })
}

const Meters = makeMeters(Schema.NumberFromString)
const BigMeters = makeMeters(Schema.BigIntFromString)
const NumMeters = makeMeters(Schema.Number, "Gauge")
const StrMeters = makeMeters(Schema.String, "Stamp")
const MainTable = Table.make({
  schema: AppSchema,
  entities: { Meters, BigMeters, NumMeters, StrMeters },
})

/** Transactions still to cancel for a `TransactionConflict` before one is sent. */
const contention = { next: 0 }

/** DynamoDB Local, cancelling the next `contention.next` transactions as contended DynamoDB does. */
const ContendedClient = Layer.effect(
  DynamoClient,
  Effect.map(
    DynamoClient,
    (client): DynamoClientService => ({
      ...client,
      transactWriteItems: (input) => {
        if (contention.next === 0) return client.transactWriteItems(input)
        contention.next--
        return Effect.fail(
          new DynamoError({
            operation: "TransactWriteItems",
            cause: Object.assign(new Error("Transaction cancelled"), {
              name: "TransactionCanceledException",
              CancellationReasons: (input.TransactItems ?? []).map((_, i) => ({
                Code: i === 0 ? "TransactionConflict" : "None",
              })),
            }),
          }),
        )
      },
    }),
  ),
).pipe(
  Layer.provide(
    DynamoClient.layer({
      region: "us-east-1",
      endpoint: ENDPOINT,
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
    }),
  ),
)

const TestLayer = Layer.mergeAll(ContendedClient, MainTable.layer({ name: tableName }))
const provide = Effect.provide(TestLayer)
const makeDb = DynamoClient.make({
  entities: { Meters, BigMeters, NumMeters, StrMeters },
  tables: { MainTable },
})

/** A bound `.history()` query, as these tests drive it. */
type HistoryQuery = {
  readonly where: (f: (t: any, ops: any) => unknown) => HistoryQuery
  readonly reverse: () => HistoryQuery
  readonly collect: () => Effect.Effect<ReadonlyArray<any>, unknown>
}

type Op = "eq" | "lt" | "lte" | "gt" | "gte" | "between" | "beginsWith"
const OPS: ReadonlyArray<Op> = ["eq", "lt", "lte", "gt", "gte", "between", "beginsWith"]

/** Does `value` satisfy the operator (`beginsWith` on a number is `eq`)? */
const satisfies = <N extends number | bigint>(op: Op, value: N, a: N, b: N): boolean => {
  switch (op) {
    case "eq":
    case "beginsWith":
      return value === a
    case "lt":
      return value < a
    case "lte":
      return value <= a
    case "gt":
      return value > a
    case "gte":
      return value >= a
    case "between":
      return value >= a && value <= b
  }
}

const whereOf =
  (op: Op, a: unknown, b: unknown) =>
  (t: any, ops: any): unknown =>
    op === "between" ? ops.between(t.seq, a, b) : ops[op](t.seq, a)

type Bound = {
  readonly append: (input: object) => {
    readonly asEffect: () => Effect.Effect<any, any>
    readonly skipFollowUp: () => { readonly asEffect: () => Effect.Effect<any, any> }
    readonly condition: (cond: object) => { readonly asEffect: () => Effect.Effect<any, any> }
  }
  readonly history: (key: object) => HistoryQuery
}

/** The event rows of `site`, read raw: their sort keys (the key is lower-cased). */
const eventKeysOf = (site: string, entityType = "reading") =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const result = yield* client.query({
      TableName: tableName,
      KeyConditionExpression: "#pk = :pk",
      ExpressionAttributeNames: { "#pk": "pk" },
      ExpressionAttributeValues: {
        ":pk": { S: `$event-keys#v1#${entityType}#site_${site.toLowerCase()}` },
      },
      ConsistentRead: true,
    })
    return (result.Items ?? []).map((item) => item.sk?.S ?? "").filter((sk) => sk.includes("#e#"))
  })

const cases = [
  {
    name: "NumberFromString",
    entity: "Meters" as const,
    appended: [-1, 2.5, 9, 10, 100],
    operands: [-2, -1, 0, 2.5, 9, 10, 50, 100, 101],
    older: [50, 100, -1],
    tenKey: "0000000000000010",
  },
  {
    name: "BigIntFromString",
    entity: "BigMeters" as const,
    appended: [-100n, -1n, 9n, 10n, 100n],
    operands: [-101n, -100n, -1n, 0n, 9n, 10n, 50n, 100n, 101n],
    older: [50n, 100n, -100n],
    tenKey: "00000000000000000000000000000000000010",
  },
] as const

describeConnected("#171 F2 / E9 time-series events on a numeric-string orderBy — connected", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.createTable({
          TableName: tableName,
          BillingMode: "PAY_PER_REQUEST",
          ...Table.definition(MainTable),
        })
      }).pipe(provide),
    )
  }, 30_000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(
        provide,
        Effect.catchTag("ResourceNotFoundError", () => Effect.void),
      ),
    )
  }, 30_000)

  for (const c of cases) {
    it.effect(
      `${c.name}: increasing appends apply; history and every .where() operator in numeric order`,
      () =>
        Effect.gen(function* () {
          const db = yield* makeDb
          const entity = db.entities[c.entity] as unknown as Bound
          const site = `${c.name}-order`
          const key = { site, meter: "m-1" }
          for (const seq of c.appended) {
            const result = yield* entity.append({ ...key, seq, note: `n${seq}` }).asEffect()
            expect(result.current.seq, `append ${seq}`).toBe(seq)
          }
          expect(yield* eventKeysOf(site)).toContain(
            `$event-keys#v1#reading#meter_m-1#e#${c.tenKey}`,
          )
          const forward = yield* entity.history(key).collect()
          expect(forward.map((r: { seq: unknown }) => r.seq)).toEqual([...c.appended])
          const reverse = yield* entity.history(key).reverse().collect()
          expect(reverse.map((r: { seq: unknown }) => r.seq)).toEqual([...c.appended].reverse())
          for (const op of OPS) {
            for (const a of c.operands) {
              for (const b of op === "between" ? c.operands.filter((b) => b >= a) : [a]) {
                const want = (c.appended as ReadonlyArray<number | bigint>).filter((v) =>
                  satisfies(op, v, a, b),
                )
                for (const reversed of [false, true]) {
                  const query = entity.history(key).where(whereOf(op, a, b))
                  const got = yield* (reversed ? query.reverse() : query).collect()
                  expect(
                    got.map((r: { seq: unknown }) => r.seq),
                    `${op} ${a} ${b}${reversed ? " reversed" : ""}`,
                  ).toEqual(reversed ? [...want].reverse() : want)
                }
              }
            }
          }
        }).pipe(provide) as Effect.Effect<void, unknown>,
      120_000,
    )

    it.effect(`${c.name}: an older or equal append after a newer one is stale, no event`, () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        const entity = db.entities[c.entity] as unknown as Bound
        const site = `${c.name}-stale`
        const key = { site, meter: "m-1" }
        for (const seq of c.appended) {
          yield* entity.append({ ...key, seq, note: `n${seq}` }).asEffect()
        }
        const events = yield* eventKeysOf(site)
        for (const seq of c.older) {
          const error = yield* entity
            .append({ ...key, seq, note: "late" })
            .asEffect()
            .pipe(Effect.flip)
          expect(error._tag, `${seq}`).toBe("StaleAppend")
          expect(Option.getOrThrow(error.current as Option.Option<{ seq: unknown }>).seq).toBe(
            c.appended[4],
          )
        }
        expect(yield* eventKeysOf(site)).toEqual(events)
        const current = yield* entity.history(key).collect()
        expect(current.map((r: { note: string }) => r.note)).not.toContain("late")
      }).pipe(provide),
    )
  }

  it.effect("9, 10 and 100 all apply; then 50 is stale and writes no event", () =>
    Effect.gen(function* () {
      const db = yield* makeDb
      const key = { site: "nine-ten", meter: "m-1" }
      for (const seq of [9, 10, 100]) {
        const result = yield* db.entities.Meters.append({ ...key, seq, note: `${seq}` }).asEffect()
        expect(result.current.seq).toBe(seq)
      }
      expect(yield* eventKeysOf("nine-ten")).toHaveLength(3)
      const error = yield* db.entities.Meters.append({ ...key, seq: 50, note: "late" })
        .asEffect()
        .pipe(Effect.flip)
      expect(error._tag).toBe("StaleAppend")
      expect(yield* eventKeysOf("nine-ten")).toHaveLength(3)
    }).pipe(provide),
  )

  it.effect("concurrent appends settle on the greatest; each applied one has its event", () =>
    Effect.gen(function* () {
      const db = yield* makeDb
      const key = { site: "race", meter: "m-1" }
      yield* db.entities.Meters.append({ ...key, seq: 10, note: "10" }).asEffect()
      const seqs = [11, 12, 13, 14, 15, 16]
      const outcomes = yield* Effect.forEach(
        seqs,
        (seq) =>
          db.entities.Meters.append({ ...key, seq, note: `${seq}` })
            .asEffect()
            .pipe(
              Effect.as(true),
              Effect.catchTag("StaleAppend", () => Effect.succeed(false)),
            ),
        { concurrency: "unbounded" },
      )
      const events = yield* db.entities.Meters.history(key).collect()
      const history = events.map((r) => r.seq)
      expect(history).toContain(16)
      expect(history).toEqual([...history].sort((a, b) => a - b))
      seqs.forEach((seq, i) => {
        expect(history.includes(seq), `${seq}`).toBe(outcomes[i])
      })
      const current = yield* db.entities.Meters.append({ ...key, seq: 16, note: "again" })
        .asEffect()
        .pipe(Effect.flip)
      expect(
        current._tag === "StaleAppend" &&
          Option.getOrThrow(current.current as Option.Option<{ seq: number }>).seq,
      ).toBe(16)
    }).pipe(provide),
  )

  it.effect("the user's condition still decides; skipFollowUp returns nothing", () =>
    Effect.gen(function* () {
      const db = yield* makeDb
      const key = { site: "conditions", meter: "m-1" }
      yield* db.entities.Meters.append({ ...key, seq: 9, note: "a" }).asEffect()
      const rejected = yield* db.entities.Meters.append({ ...key, seq: 10, note: "b" })
        .condition({ note: "nope" })
        .asEffect()
        .pipe(Effect.flip)
      expect(rejected._tag).toBe("ConditionalCheckFailed")
      const held = yield* db.entities.Meters.append({ ...key, seq: 10, note: "b" })
        .condition({ note: "a" })
        .asEffect()
      expect(held.current.seq).toBe(10)
      expect(
        yield* db.entities.Meters.append({ ...key, seq: 11, note: "c" })
          .skipFollowUp()
          .asEffect(),
      ).toBeUndefined()
      const stale = yield* db.entities.Meters.append({ ...key, seq: 2, note: "d" })
        .skipFollowUp()
        .asEffect()
        .pipe(Effect.flip)
      expect(stale._tag).toBe("StaleAppend")
      expect(yield* eventKeysOf("conditions")).toHaveLength(3)
    }).pipe(provide),
  )

  const ORDER_BY_TYPES = [
    { name: "NumberFromString", entity: "Meters", type: "reading", seq: (n: number) => n },
    {
      name: "BigIntFromString",
      entity: "BigMeters",
      type: "reading",
      seq: (n: number) => BigInt(n),
    },
    { name: "Number", entity: "NumMeters", type: "gauge", seq: (n: number) => n },
    { name: "String", entity: "StrMeters", type: "stamp", seq: (n: number) => `t${n}` },
  ] as const
  for (const c of ORDER_BY_TYPES) {
    it.effect(`${c.name}: a TransactionConflict cancellation is sent again, and applies`, () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        const bound = db.entities[c.entity] as unknown as Bound
        const key = { site: `contended-${c.name}`, meter: "m-1" }
        // The append creating the item, one over it, and one a true condition holds.
        contention.next = 1
        yield* bound.append({ ...key, seq: c.seq(1), note: "a" }).asEffect()
        contention.next = 2
        const over = yield* bound.append({ ...key, seq: c.seq(2), note: "b" }).asEffect()
        expect(over.current.seq).toEqual(c.seq(2))
        contention.next = 1
        const held = yield* bound
          .append({ ...key, seq: c.seq(3), note: "c" })
          .condition({ note: "b" })
          .asEffect()
        expect(held.current.seq).toEqual(c.seq(3))
        expect(contention.next).toBe(0)
        expect(yield* eventKeysOf(key.site, c.type)).toHaveLength(3)
      }).pipe(provide),
    )

    it.effect(`${c.name}: a condition rejecting the append creating the item is a condition`, () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        const bound = db.entities[c.entity] as unknown as Bound
        const key = { site: `refused-${c.name}`, meter: "m-1" }
        const rejected = yield* bound
          .append({ ...key, seq: c.seq(1), note: "a" })
          .condition({ note: "nope" })
          .asEffect()
          .pipe(Effect.flip)
        expect(rejected._tag).toBe("ConditionalCheckFailed")
        expect(Option.isNone(rejected.current)).toBe(true)
        expect(yield* eventKeysOf(key.site, c.type)).toEqual([])
      }).pipe(provide),
    )
  }
})
