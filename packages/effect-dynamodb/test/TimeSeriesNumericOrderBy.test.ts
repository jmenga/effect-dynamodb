/**
 * A time-series entity whose `orderBy` is a string-encoded number
 * (`NumberFromString`, `BigIntFromString`; #171 F2 and E9), against an
 * in-memory DynamoDB that evaluates conditions as DynamoDB does (`S` as text).
 *
 * - F2: the event key's orderBy segment is the orderBy's key form — the
 *   number's key text — as `.history().where()` composes its bounds, so
 *   `.history()` returns events in numeric order and every operator returns
 *   the events it means. Up to 1.36 it was the encoded text: `10` sorted
 *   before `9`.
 * - E9: the stored orderBy is `S`, so the `<` CAS compared text and refused
 *   `10` after `9`. Such an append now reads the current item, compares the
 *   numbers, and guards the write on the stored value it read.
 */
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer, Option, Schema } from "effect"
import { beforeEach } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { calls, hooks, InMemoryClient, resetStore, sent, store } from "./helpers/InMemoryTables.js"

const AppSchema = DynamoSchema.make({ name: "tsnum", version: 1 })

const makeMeters = <S extends Schema.Top>(seq: S) => {
  const Reading = Schema.Struct({
    site: Schema.String,
    meter: Schema.String,
    seq,
    note: Schema.String,
  })
  return Entity.make({
    model: Reading,
    entityType: "Reading",
    primaryKey: {
      pk: { field: "pk", composite: ["site"] },
      sk: { field: "sk", composite: ["meter"] },
    },
    timeSeries: { orderBy: "seq", appendInput: Reading },
  })
}

const Meters = makeMeters(Schema.NumberFromString)
const BigMeters = makeMeters(Schema.BigIntFromString)
const MainTable = Table.make({ schema: AppSchema, entities: { Meters, BigMeters } })
const layer = Layer.mergeAll(InMemoryClient, MainTable.layer({ name: "tsnum" }))
const makeDb = DynamoClient.make({ entities: { Meters, BigMeters }, tables: { MainTable } })

beforeEach(() => resetStore())

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

/** The event rows in the store: sort keys after `#e#`. */
const eventKeys = () =>
  [...store.values()].map((item) => item.sk?.S ?? "").filter((sk) => sk.includes("#e#"))

const cases = [
  {
    name: "NumberFromString",
    entity: "Meters" as const,
    appended: [-1, 2.5, 9, 10, 100],
    operands: [-2, -1, 0, 2.5, 9, 10, 50, 100, 101],
    older: 50,
    keyText: (n: number) => `0000000000000${String(n).padStart(3, "0")}`,
  },
  {
    name: "BigIntFromString",
    entity: "BigMeters" as const,
    appended: [-100n, -1n, 9n, 10n, 100n],
    operands: [-101n, -100n, -1n, 0n, 9n, 10n, 50n, 100n, 101n],
    older: 50n,
    keyText: (n: bigint) => String(n).padStart(38, "0"),
  },
] as const

describe("time-series events on a string-encoded numeric orderBy (#171 F2, E9)", () => {
  for (const c of cases) {
    const key = { site: "s-1", meter: "m-1" }
    const appendAll = Effect.gen(function* () {
      const db = yield* makeDb
      const entity = db.entities[c.entity] as unknown as {
        append: (input: object) => { asEffect: () => Effect.Effect<any, any> }
        history: (key: object) => HistoryQuery
      }
      for (const seq of c.appended) {
        const result = yield* entity.append({ ...key, seq, note: `n${seq}` }).asEffect()
        expect(result.current.seq, `${c.name} append ${seq}`).toBe(seq)
      }
      return entity
    })

    it.effect(`${c.name}: increasing appends all apply, and history is in numeric order`, () =>
      Effect.gen(function* () {
        const entity = yield* appendAll
        const forward = yield* entity.history(key).collect()
        expect(forward.map((r: { seq: unknown }) => r.seq)).toEqual([...c.appended])
        const reverse = yield* entity.history(key).reverse().collect()
        expect(reverse.map((r: { seq: unknown }) => r.seq)).toEqual([...c.appended].reverse())
      }).pipe(Effect.provide(layer)),
    )

    it.effect(`${c.name}: every .where() operator, forward and reverse`, () =>
      Effect.gen(function* () {
        const entity = yield* appendAll
        for (const op of OPS) {
          for (const a of c.operands) {
            for (const b of op === "between" ? c.operands.filter((b) => b >= a) : [a]) {
              const want = (c.appended as ReadonlyArray<number | bigint>).filter((v) =>
                satisfies(op, v, a, b),
              )
              for (const reverse of [false, true]) {
                const query = entity.history(key).where(whereOf(op, a, b))
                const got = yield* (reverse ? query.reverse() : query).collect()
                expect(
                  got.map((r: { seq: unknown }) => r.seq),
                  `${op} ${a} ${b}${reverse ? " reversed" : ""}`,
                ).toEqual(reverse ? [...want].reverse() : want)
              }
            }
          }
        }
      }).pipe(Effect.provide(layer)),
    )

    it.effect(`${c.name}: the event key holds the number's key text`, () =>
      Effect.gen(function* () {
        yield* appendAll
        const keys = eventKeys()
        const ten = c.appended[3]!
        expect(keys).toContain(
          `$tsnum#v1#reading#meter_m-1#e#${(c.keyText as (n: unknown) => string)(ten)}`,
        )
        // Not the encoded text, which sorted "10" before "9".
        expect(keys).not.toContain("$tsnum#v1#reading#meter_m-1#e#10")
      }).pipe(Effect.provide(layer)),
    )

    it.effect(
      `${c.name}: an older or equal append after a newer one is stale and writes nothing`,
      () =>
        Effect.gen(function* () {
          const entity = yield* appendAll
          const before = eventKeys().length
          for (const seq of [c.older, c.appended[4]!, c.appended[0]!]) {
            const error = yield* entity
              .append({ ...key, seq, note: "late" })
              .asEffect()
              .pipe(Effect.flip)
            expect(error._tag, `${seq}`).toBe("StaleAppend")
            expect(error.attemptedOrderBy).toBe(String(seq))
            expect(Option.getOrThrow(error.current as Option.Option<{ seq: unknown }>).seq).toBe(
              c.appended[4],
            )
          }
          expect(eventKeys()).toHaveLength(before)
          const current = [...store.values()].find(
            (item) => item.sk?.S === "$tsnum#v1#reading#meter_m-1",
          )
          expect(current?.note).toEqual({ S: `n${c.appended[4]}` })
        }).pipe(Effect.provide(layer)),
    )
  }

  it.effect("9, 10 and 100 all apply; then 50 is stale and writes no event", () =>
    Effect.gen(function* () {
      const db = yield* makeDb
      const key = { site: "s-2", meter: "m-1" }
      for (const seq of [9, 10, 100]) {
        const result = yield* db.entities.Meters.append({ ...key, seq, note: `${seq}` }).asEffect()
        expect(result.current.seq).toBe(seq)
      }
      expect(eventKeys()).toHaveLength(3)
      const error = yield* db.entities.Meters.append({ ...key, seq: 50, note: "late" })
        .asEffect()
        .pipe(Effect.flip)
      expect(error._tag).toBe("StaleAppend")
      expect(eventKeys()).toHaveLength(3)
    }).pipe(Effect.provide(layer)),
  )

  it.effect("reads consistently first, then guards the write on the value it read", () =>
    Effect.gen(function* () {
      const db = yield* makeDb
      const key = { site: "s-3", meter: "m-1" }
      yield* db.entities.Meters.append({ ...key, seq: 9, note: "a" }).asEffect()
      const first = sent.transactWriteItems[0]!.TransactItems![0]!.Update!
      expect(first.ConditionExpression).toBe("attribute_not_exists(#_tspk)")
      expect(first.ExpressionAttributeNames?.["#_tsob"]).toBeUndefined()
      expect(first.ExpressionAttributeValues?.[":_tsNewOb"]).toBeUndefined()
      expect(sent.getItem[0]?.ConsistentRead).toBe(true)

      yield* db.entities.Meters.append({ ...key, seq: 10, note: "b" }).asEffect()
      const second = sent.transactWriteItems[1]!.TransactItems![0]!.Update!
      expect(second.ConditionExpression).toBe("#_tsob = :_tsObserved")
      expect(second.ExpressionAttributeValues?.[":_tsObserved"]).toEqual({ S: "9" })
      expect(second.ExpressionAttributeNames?.["#_tspk"]).toBeUndefined()
    }).pipe(Effect.provide(layer)),
  )

  it.effect("a concurrent append between the read and the write: read again, then apply", () =>
    Effect.gen(function* () {
      const db = yield* makeDb
      const key = { site: "s-4", meter: "m-1" }
      yield* db.entities.Meters.append({ ...key, seq: 9, note: "a" }).asEffect()
      const currentKey = "tsnum|$tsnum#v1#reading#site_s-4|$tsnum#v1#reading#meter_m-1"
      // Another writer moves the item to 10 after this append's first read.
      hooks.afterGet.push(() => {
        store.set(currentKey, { ...store.get(currentKey)!, seq: { S: "10" } })
      })
      const writes = calls.transactWriteItems
      const result = yield* db.entities.Meters.append({ ...key, seq: 11, note: "b" }).asEffect()
      expect(result.current.seq).toBe(11)
      expect(calls.transactWriteItems - writes).toBe(2)
    }).pipe(Effect.provide(layer)),
  )

  it.effect("a concurrent append past this one: read again, then stale", () =>
    Effect.gen(function* () {
      const db = yield* makeDb
      const key = { site: "s-5", meter: "m-1" }
      yield* db.entities.Meters.append({ ...key, seq: 9, note: "a" }).asEffect()
      const currentKey = "tsnum|$tsnum#v1#reading#site_s-5|$tsnum#v1#reading#meter_m-1"
      hooks.afterGet.push(() => {
        store.set(currentKey, { ...store.get(currentKey)!, seq: { S: "12" } })
      })
      const events = eventKeys().length
      const error = yield* db.entities.Meters.append({ ...key, seq: 11, note: "b" })
        .asEffect()
        .pipe(Effect.flip)
      expect(error._tag).toBe("StaleAppend")
      expect(eventKeys()).toHaveLength(events)
    }).pipe(Effect.provide(layer)),
  )

  it.effect("a write that keeps losing to concurrent appends fails after 8 attempts", () =>
    Effect.gen(function* () {
      const db = yield* makeDb
      const key = { site: "s-8", meter: "m-1" }
      yield* db.entities.Meters.append({ ...key, seq: 9, note: "a" }).asEffect()
      const currentKey = "tsnum|$tsnum#v1#reading#site_s-8|$tsnum#v1#reading#meter_m-1"
      // After every read, another writer moves the item on — still below 1000.
      let moves = 0
      const move = () => {
        moves++
        store.set(currentKey, { ...store.get(currentKey)!, seq: { S: String(9 + moves) } })
        hooks.afterGet.push(move)
      }
      hooks.afterGet.push(move)
      const writes = calls.transactWriteItems
      const events = eventKeys().length
      const error = yield* db.entities.Meters.append({ ...key, seq: 1000, note: "b" })
        .asEffect()
        .pipe(Effect.flip)
      hooks.afterGet = []
      expect(error._tag).toBe("DynamoError")
      expect(calls.transactWriteItems - writes).toBe(8)
      expect(eventKeys()).toHaveLength(events)
    }).pipe(Effect.provide(layer)),
  )

  it.effect("the user's condition rejecting the write is ConditionalCheckFailed", () =>
    Effect.gen(function* () {
      const db = yield* makeDb
      const key = { site: "s-6", meter: "m-1" }
      // On a new item too: no current item to report, and no event written.
      const first = yield* db.entities.Meters.append({ ...key, seq: 9, note: "a" })
        .condition({ note: "nope" })
        .asEffect()
        .pipe(Effect.flip)
      expect(first._tag).toBe("ConditionalCheckFailed")
      expect(first._tag === "ConditionalCheckFailed" && Option.isNone(first.current!)).toBe(true)
      expect(eventKeys()).toEqual([])
      yield* db.entities.Meters.append({ ...key, seq: 9, note: "a" }).asEffect()
      const error = yield* db.entities.Meters.append({ ...key, seq: 10, note: "b" })
        .condition({ note: "nope" })
        .asEffect()
        .pipe(Effect.flip)
      expect(error._tag).toBe("ConditionalCheckFailed")
      const held = yield* db.entities.Meters.append({ ...key, seq: 10, note: "b" })
        .condition({ note: "a" })
        .asEffect()

      expect(held.current.seq).toBe(10)
    }).pipe(Effect.provide(layer)),
  )

  it.effect("skipFollowUp: void when applied, StaleAppend without current when stale", () =>
    Effect.gen(function* () {
      const db = yield* makeDb
      const key = { site: "s-7", meter: "m-1" }
      expect(
        yield* db.entities.Meters.append({ ...key, seq: 9, note: "a" })
          .skipFollowUp()
          .asEffect(),
      ).toBeUndefined()
      expect(
        yield* db.entities.Meters.append({ ...key, seq: 10, note: "b" })
          .skipFollowUp()
          .asEffect(),
      ).toBeUndefined()
      const error = yield* db.entities.Meters.append({ ...key, seq: 2, note: "c" })
        .skipFollowUp()
        .asEffect()
        .pipe(Effect.flip)
      expect(error._tag === "StaleAppend" && Option.isNone(error.current)).toBe(true)
    }).pipe(Effect.provide(layer)),
  )
})
