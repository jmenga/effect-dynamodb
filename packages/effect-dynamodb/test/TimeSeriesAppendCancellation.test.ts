/**
 * How a time-series `append` reads a cancelled transaction, for every kind of
 * `orderBy` — string-encoded numbers (`NumberFromString`, `BigIntFromString`,
 * #171 E9's read-then-guard path), `Number` and a string (the single
 * conditional transaction) — against an in-memory DynamoDB that evaluates
 * conditions as DynamoDB does.
 *
 * - A `TransactionConflict` cancellation (another transaction in flight on the
 *   item, which real DynamoDB raises and DynamoDB Local never does) is no
 *   verdict: nothing was judged and nothing written, so the transaction is
 *   sent again, up to 8 attempts in all. Taken for a verdict, a re-read found
 *   the item unchanged and the append was dropped as stale.
 * - A user condition rejecting the append that would create the item is
 *   `ConditionalCheckFailed` without `current` (#171 G5); up to 1.36 a
 *   `ValidationError("append.followUp")` on every orderBy but the
 *   string-encoded numeric ones.
 * - With a user condition, the request is 1.36's, byte for byte: the CAS's
 *   names and values come before the condition's.
 * - Every read an append sends is strongly consistent: one after an applied
 *   append that missed the item it had just created was a `ValidationError`.
 */
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer, Option, Schema } from "effect"
import { beforeEach } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import {
  calls,
  contention,
  InMemoryClient,
  resetStore,
  sent,
  store,
} from "./helpers/InMemoryTables.js"

const AppSchema = DynamoSchema.make({ name: "tscancel", version: 1 })

const makeMeters = <S extends Schema.Top>(seq: S, entityType: string) => {
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

const NumStr = makeMeters(Schema.NumberFromString, "NumStr")
const BigStr = makeMeters(Schema.BigIntFromString, "BigStr")
const Num = makeMeters(Schema.Number, "Num")
const Str = makeMeters(Schema.String, "Str")
const MainTable = Table.make({ schema: AppSchema, entities: { NumStr, BigStr, Num, Str } })
const layer = Layer.mergeAll(InMemoryClient, MainTable.layer({ name: "tscancel" }))
const makeDb = DynamoClient.make({ entities: { NumStr, BigStr, Num, Str }, tables: { MainTable } })

beforeEach(() => resetStore())

type Appender = {
  readonly append: (input: object) => {
    readonly condition: (condition: object) => { readonly asEffect: () => Effect.Effect<any, any> }
    readonly asEffect: () => Effect.Effect<any, any>
  }
}

/** Each orderBy kind, with an earlier and a later value. */
const cases = [
  { name: "NumberFromString", entity: "NumStr", first: 9, next: 10 },
  { name: "BigIntFromString", entity: "BigStr", first: 9n, next: 10n },
  { name: "Number", entity: "Num", first: 9, next: 10 },
  { name: "a string", entity: "Str", first: "2024-01-09", next: "2024-01-10" },
] as const

/** The rows in the store under `site`: its events and its current item. */
const rowsOf = (site: string) =>
  [...store.values()].filter((item) => item.pk?.S?.endsWith(`#site_${site}`))
const eventsOf = (site: string) => rowsOf(site).filter((item) => item.sk?.S?.includes("#e#"))

describe("a TransactionConflict cancellation is sent again (#171 E9)", () => {
  for (const c of cases) {
    const entityOf = Effect.map(
      makeDb,
      (db) => (db.entities as unknown as Record<string, Appender>)[c.entity]!,
    )

    it.effect(`${c.name}: an append over an existing item applies`, () =>
      Effect.gen(function* () {
        const entity = yield* entityOf
        const key = { site: "existing", meter: "m-1" }
        yield* entity.append({ ...key, seq: c.first, note: "a" }).asEffect()
        contention.next = 1
        const writes = calls.transactWriteItems
        const result = yield* entity.append({ ...key, seq: c.next, note: "b" }).asEffect()
        expect(result.current.seq).toBe(c.next)
        expect(calls.transactWriteItems - writes).toBe(2)
        expect(eventsOf("existing")).toHaveLength(2)
      }).pipe(Effect.provide(layer)),
    )

    it.effect(`${c.name}: the first append, creating the item, applies`, () =>
      Effect.gen(function* () {
        const entity = yield* entityOf
        contention.next = 1
        const result = yield* entity
          .append({ site: "new", meter: "m-1", seq: c.first, note: "a" })
          .asEffect()
        expect(result.current.seq).toBe(c.first)
        expect(calls.transactWriteItems).toBe(2)
        expect(eventsOf("new")).toHaveLength(1)
      }).pipe(Effect.provide(layer)),
    )

    it.effect(`${c.name}: an append whose user condition holds applies`, () =>
      Effect.gen(function* () {
        const entity = yield* entityOf
        const key = { site: "held", meter: "m-1" }
        yield* entity.append({ ...key, seq: c.first, note: "a" }).asEffect()
        contention.next = 1
        const result = yield* entity
          .append({ ...key, seq: c.next, note: "b" })
          .condition({ note: "a" })
          .asEffect()
        expect(result.current.seq).toBe(c.next)
        expect(result.current.note).toBe("b")
      }).pipe(Effect.provide(layer)),
    )

    it.effect(`${c.name}: still contended after 8 attempts, the transaction's error`, () =>
      Effect.gen(function* () {
        const entity = yield* entityOf
        const key = { site: "contended", meter: "m-1" }
        yield* entity.append({ ...key, seq: c.first, note: "a" }).asEffect()
        contention.next = 8
        const writes = calls.transactWriteItems
        const error = yield* entity
          .append({ ...key, seq: c.next, note: "b" })
          .asEffect()
          .pipe(Effect.flip)
        expect(error._tag).toBe("DynamoError")
        expect(error.cause.name).toBe("TransactionCanceledException")
        expect(calls.transactWriteItems - writes).toBe(8)
        expect(eventsOf("contended")).toHaveLength(1)
        // Once the contention ends, the same append applies.
        const result = yield* entity.append({ ...key, seq: c.next, note: "b" }).asEffect()
        expect(result.current.seq).toBe(c.next)
      }).pipe(Effect.provide(layer)),
    )

    it.effect(
      `${c.name}: a user condition rejecting the append creating the item is ConditionalCheckFailed (G5)`,
      () =>
        Effect.gen(function* () {
          const entity = yield* entityOf
          const error = yield* entity
            .append({ site: "rejected", meter: "m-1", seq: c.first, note: "a" })
            .condition({ note: "nope" })
            .asEffect()
            .pipe(Effect.flip)
          expect(error._tag).toBe("ConditionalCheckFailed")
          expect(Option.isNone(error.current)).toBe(true)
          expect(rowsOf("rejected")).toEqual([])
        }).pipe(Effect.provide(layer)),
    )
  }
})

describe("every read an append sends is strongly consistent (#171)", () => {
  for (const c of cases) {
    it.effect(`${c.name}: after creating the item, over it, and stale`, () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        const entity = (db.entities as unknown as Record<string, Appender>)[c.entity]!
        const key = { site: "consistent", meter: "m-1" }
        yield* entity.append({ ...key, seq: c.first, note: "a" }).asEffect()
        yield* entity.append({ ...key, seq: c.next, note: "b" }).asEffect()
        const stale = yield* entity
          .append({ ...key, seq: c.first, note: "c" })
          .asEffect()
          .pipe(Effect.flip)
        expect(stale._tag).toBe("StaleAppend")
        // Each append reads the current item after its transaction.
        expect(sent.getItem.length).toBeGreaterThanOrEqual(3)
        for (const input of sent.getItem) expect(input.ConsistentRead).toBe(true)
      }).pipe(Effect.provide(layer)),
    )
  }
})

// ---------------------------------------------------------------------------
// 1.36's request bytes
// ---------------------------------------------------------------------------

const CapSchema = DynamoSchema.make({ name: "cap", version: 1 })
const CapReading = Schema.Struct({
  site: Schema.String,
  dev: Schema.String,
  at: Schema.Number,
  note: Schema.String,
  n: Schema.Number,
  flag: Schema.Boolean,
})
const Readings = Entity.make({
  model: CapReading,
  entityType: "Reading",
  primaryKey: {
    pk: { field: "pk", composite: ["site"] },
    sk: { field: "sk", composite: ["dev"] },
  },
  indexes: {
    byNote: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["site"] },
      sk: { field: "gsi1sk", composite: ["note", "n", "flag"] },
    },
  },
  timeSeries: { orderBy: "at", appendInput: CapReading },
})
const CapStamp = Schema.Struct({
  site: Schema.String,
  dev: Schema.String,
  stamp: Schema.String,
  note: Schema.String,
})
const Stamps = Entity.make({
  model: CapStamp,
  entityType: "Stamp",
  primaryKey: {
    pk: { field: "pk", composite: ["site"] },
    sk: { field: "sk", composite: ["dev"] },
  },
  timeSeries: { orderBy: "stamp", appendInput: CapStamp },
})
const CapTable = Table.make({ schema: CapSchema, entities: { Readings, Stamps } })
const capLayer = Layer.mergeAll(InMemoryClient, CapTable.layer({ name: "<T>" }))

/**
 * The `TransactWriteItems` input 1.36.0 sent for each append, captured from
 * the published package (table name `<T>`).
 */
const SENT_136 = {
  number:
    '{"TransactItems":[{"Update":{"TableName":"<T>","Key":{"pk":{"S":"$cap#v1#reading#site_s1"},"sk":{"S":"$cap#v1#reading#dev_dev-a"}},"UpdateExpression":"SET #a0 = :a0, #a1 = :a1, #a2 = :a2, #a3 = :a3, #a4 = :a4, #a5 = :a5, #a6 = :a6, #a7 = :a7, #a8 = :a8","ConditionExpression":"(attribute_not_exists(#_tspk) OR #_tsob < :_tsNewOb) AND (#e0 = :e1)","ExpressionAttributeNames":{"#a0":"site","#a1":"dev","#a2":"at","#a3":"note","#a4":"n","#a5":"flag","#a6":"gsi1pk","#a7":"gsi1sk","#a8":"__edd_e__","#_tspk":"pk","#_tsob":"at","#e0":"eq"},"ExpressionAttributeValues":{":a0":{"S":"S1"},":a1":{"S":"Dev-A"},":a2":{"N":"5"},":a3":{"S":"Hello"},":a4":{"N":"7"},":a5":{"BOOL":true},":a6":{"S":"$cap#v1#reading#site_s1"},":a7":{"S":"$cap#v1#reading#note_hello#n_0000000000000007#flag_true"},":a8":{"S":"Reading"},":_tsNewOb":{"N":"5"},":e1":{"M":{"note":{"S":"Hello"}}}}}},{"Put":{"TableName":"<T>","Item":{"site":{"S":"S1"},"dev":{"S":"Dev-A"},"at":{"N":"5"},"note":{"S":"Hello"},"n":{"N":"7"},"flag":{"BOOL":true},"pk":{"S":"$cap#v1#reading#site_s1"},"sk":{"S":"$cap#v1#reading#dev_dev-a#e#0000000000000005"},"__edd_e__":{"S":"Reading"}}}}]}',
  string:
    '{"TransactItems":[{"Update":{"TableName":"<T>","Key":{"pk":{"S":"$cap#v1#stamp#site_s1"},"sk":{"S":"$cap#v1#stamp#dev_dev-a"}},"UpdateExpression":"SET #a0 = :a0, #a1 = :a1, #a2 = :a2, #a3 = :a3, #a4 = :a4","ConditionExpression":"(attribute_not_exists(#_tspk) OR #_tsob < :_tsNewOb) AND (#e0 = :e1)","ExpressionAttributeNames":{"#a0":"site","#a1":"dev","#a2":"stamp","#a3":"note","#a4":"__edd_e__","#_tspk":"pk","#_tsob":"stamp","#e0":"eq"},"ExpressionAttributeValues":{":a0":{"S":"S1"},":a1":{"S":"Dev-A"},":a2":{"S":"2024-01-02T00:00:00Z"},":a3":{"S":"x"},":a4":{"S":"Stamp"},":_tsNewOb":{"S":"2024-01-02T00:00:00Z"},":e1":{"M":{"note":{"S":"x"}}}}}},{"Put":{"TableName":"<T>","Item":{"site":{"S":"S1"},"dev":{"S":"Dev-A"},"stamp":{"S":"2024-01-02T00:00:00Z"},"note":{"S":"x"},"pk":{"S":"$cap#v1#stamp#site_s1"},"sk":{"S":"$cap#v1#stamp#dev_dev-a#e#2024-01-02t00:00:00z"},"__edd_e__":{"S":"Stamp"}}}}]}',
}

describe("an append with a user condition sends 1.36's request (#171)", () => {
  it.effect("a Number orderBy: the CAS's names and values before the condition's", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Readings, Stamps }, tables: { CapTable } })
      const reading = { site: "S1", dev: "Dev-A", note: "Hello", n: 7, flag: true }
      yield* db.entities.Readings.append({ ...reading, at: 1 }).asEffect()
      yield* db.entities.Readings.append({ ...reading, at: 5 })
        .condition({ eq: { note: "Hello" } } as never)
        .asEffect()
        .pipe(Effect.ignore)
      expect(JSON.stringify(sent.transactWriteItems[1])).toBe(SENT_136.number)
    }).pipe(Effect.provide(capLayer)),
  )

  it.effect("a string orderBy: the CAS's names and values before the condition's", () =>
    Effect.gen(function* () {
      const db = yield* DynamoClient.make({ entities: { Readings, Stamps }, tables: { CapTable } })
      const stamp = { site: "S1", dev: "Dev-A", note: "x" }
      yield* db.entities.Stamps.append({ ...stamp, stamp: "2024-01-01T00:00:00Z" }).asEffect()
      yield* db.entities.Stamps.append({ ...stamp, stamp: "2024-01-02T00:00:00Z" })
        .condition({ eq: { note: "x" } } as never)
        .asEffect()
        .pipe(Effect.ignore)
      expect(JSON.stringify(sent.transactWriteItems[1])).toBe(SENT_136.string)
    }).pipe(Effect.provide(capLayer)),
  )
})
