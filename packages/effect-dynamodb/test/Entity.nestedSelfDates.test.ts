/**
 * Entity self dates nested in Union / Record / Tuple containers (#133).
 *
 * An entity substitutes every SELF date (`Schema.DateTimeUtc`, `Schema.Date`,
 * `storedAs(...)`) with a transform that produces its wire primitive. The
 * substitution walked Struct / Class / Array but stopped at a Union, a Record
 * or a Tuple, so a `NullOr(Schema.DateTimeUtc)` field stored the `DateTime`
 * instance itself — a marshalled `{ epochMilliseconds, … }` map that reads back
 * as a plain object. Path-based updates (`pathSet`, `pathAppend`, …) never
 * encoded their value at all.
 *
 * Keys must not move: every key attribute written is snapshotted.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DateTime, Effect, Equal, Layer, Redacted, Schema } from "effect"
import { beforeEach } from "vitest"
import * as Batch from "../src/Batch.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { mockDynamoClientLayer } from "./helpers/MockDynamoClient.js"

// ---------------------------------------------------------------------------
// In-memory raw client that records every write
// ---------------------------------------------------------------------------

type Item = Record<string, AttributeValue>
const store = new Map<string, Item>()
/** Every write request, flattened to single operations. */
const writes: Array<{ readonly op: string; readonly input: Record<string, any> }> = []

const keyOf = (item: Record<string, any>): string => `${item.pk?.S}|${item.sk?.S}`

const InMemoryClient = mockDynamoClientLayer({
  putItem: (input) =>
    Effect.sync(() => {
      writes.push({ op: "Put", input })
      store.set(keyOf(input.Item!), input.Item as Item)
      return {} as any
    }),
  getItem: (input) => Effect.sync(() => ({ Item: store.get(keyOf(input.Key!)) }) as any),
  deleteItem: (input) =>
    Effect.sync(() => {
      writes.push({ op: "Delete", input })
      const prior = store.get(keyOf(input.Key!))
      store.delete(keyOf(input.Key!))
      return { Attributes: prior } as any
    }),
  updateItem: (input) =>
    Effect.sync(() => {
      writes.push({ op: "Update", input })
      return { Attributes: store.get(keyOf(input.Key!)) } as any
    }),
  transactWriteItems: (input) =>
    Effect.sync(() => {
      for (const op of (input.TransactItems ?? []) as ReadonlyArray<Record<string, any>>) {
        if (op.Put) {
          writes.push({ op: "Put", input: op.Put })
          store.set(keyOf(op.Put.Item), op.Put.Item)
        }
        if (op.Delete) {
          writes.push({ op: "Delete", input: op.Delete })
          store.delete(keyOf(op.Delete.Key))
        }
        if (op.Update) writes.push({ op: "Update", input: op.Update })
        if (op.ConditionCheck) writes.push({ op: "Check", input: op.ConditionCheck })
      }
      return {} as any
    }),
  query: (input) =>
    Effect.sync(() => {
      const pk = (input.ExpressionAttributeValues?.[":pk"] as { S?: string } | undefined)?.S
      return { Items: [...store.values()].filter((item) => item.pk?.S === pk) } as any
    }),
})

beforeEach(() => {
  store.clear()
  writes.length = 0
})

const isKeyAttr = (name: string) => /^(pk|sk|gsi\d+(pk|sk)|lsi\d+sk)$/.test(name)

/**
 * Every key attribute a write touched, in order: item keys, the key of an
 * update/delete, and any key attribute an UpdateExpression SETs.
 */
const keyLog = (): Array<string> =>
  writes.flatMap(({ op, input }) => {
    const out: Array<string> = []
    const record = (source: Record<string, any> | undefined, label: string) => {
      for (const [k, v] of Object.entries(source ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
        if (isKeyAttr(k)) out.push(`${op} ${label} ${k}=${v?.S ?? v?.N}`)
      }
    }
    record(input.Item, "item")
    record(input.Key, "key")
    const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>
    const values = (input.ExpressionAttributeValues ?? {}) as Record<string, any>
    const expr = String(input.UpdateExpression ?? "")
    for (const [, nameKey, valKey] of expr.matchAll(/(#\w+) = (:\w+)/g)) {
      const name = names[nameKey!]
      if (name !== undefined && isKeyAttr(name)) {
        out.push(`${op} set ${name}=${values[valKey!]?.S ?? values[valKey!]?.N}`)
      }
    }
    return out
  })

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DOB = "2000-01-01T00:00:00.000Z"
const DOB_MS = 946684800000
const LATER = "2000-01-01T00:00:01.000Z"
const LATER_MS = DOB_MS + 1000
const dt = DateTime.makeUnsafe(DOB_MS)
const later = DateTime.makeUnsafe(LATER_MS)
const S = (value: string): AttributeValue => ({ S: value })

const isRealUtc = (value: unknown, ms: number): boolean =>
  DateTime.isDateTime(value) &&
  Object.getPrototypeOf(value) !== Object.prototype &&
  Equal.equals(value, DateTime.makeUnsafe(ms))

const rcMap = (ms: number): AttributeValue => ({
  M: {
    epochMilliseconds: { N: String(ms) },
    "~effect/time/DateTime": { S: "~effect/time/DateTime" },
    _tag: { S: "Utc" },
  },
})

class Stamp extends Schema.Class<Stamp>("Stamp")({ at: Schema.DateTimeUtc }) {}

/** A self date composite that is a union — the only union a key can hold. */
const When = Schema.Union([Schema.DateTimeUtc, Schema.Literals(["TBD"])])

class Fixture extends Schema.Class<Fixture>("Fixture")({
  id: Schema.String,
  team: Schema.String,
  kind: Schema.String,
  when: When,
  nullAt: Schema.NullOr(Schema.DateTimeUtc),
  nullMs: Schema.NullOr(Schema.DateTimeUtc.pipe(DynamoModel.storedAs(DynamoModel.DateEpochMs))),
  nullStamp: Schema.NullOr(Stamp),
  arrNull: Schema.Array(Schema.NullOr(Schema.DateTimeUtc)),
  rec: Schema.Record(Schema.String, Schema.DateTimeUtc),
  tup: Schema.Tuple([Schema.String, Schema.DateTimeUtc]),
  swr: Schema.StructWithRest(Schema.Struct({ at: Schema.DateTimeUtc }), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]),
  xform: Schema.NullOr(Schema.DateTimeUtcFromString),
  days: Schema.Array(Schema.DateTimeUtc),
}) {}

const Fixtures = Entity.make({
  model: Fixture,
  entityType: "Fixture",
  primaryKey: {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: ["when"] },
  },
  indexes: {
    // Shape 5 — every composite mutable, the union date composite among them.
    byKind: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["kind"] },
      sk: { field: "gsi1sk", composite: ["when"] },
    },
    // Shape 2 — composites entirely within the primary key.
    byId: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["id"] },
      sk: { field: "gsi2sk", composite: ["when"] },
    },
    // Shape 6 — an empty-composite half.
    byTeam: {
      name: "gsi3",
      pk: { field: "gsi3pk", composite: ["team"] },
      sk: { field: "gsi3sk", composite: [] },
    },
  },
  unique: { kindWhen: ["kind", "when"] },
  versioned: { retain: true },
  softDelete: true,
})

/** The same model, without lifecycle options, so `update` takes the UpdateItem path. */
const PlainFixtures = Entity.make({
  model: Fixture,
  entityType: "PlainFixture",
  primaryKey: {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: ["when"] },
  },
  indexes: {
    byKind: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["kind"] },
      sk: { field: "gsi1sk", composite: ["when"] },
    },
  },
})

class Reading extends Schema.Class<Reading>("Reading")({
  deviceId: Schema.String,
  at: Schema.DateTimeUtc,
  calibratedAt: Schema.NullOr(Schema.DateTimeUtc),
}) {}

const Readings = Entity.make({
  model: Reading,
  entityType: "Reading",
  primaryKey: {
    pk: { field: "pk", composite: ["deviceId"] },
    sk: { field: "sk", composite: [] },
  },
  timeSeries: {
    orderBy: "at",
    appendInput: Schema.Struct({
      deviceId: Schema.String,
      at: Schema.DateTimeUtc,
      calibratedAt: Schema.NullOr(Schema.DateTimeUtc),
    }),
  },
})

const AppSchema = DynamoSchema.make({ name: "edd133", version: 1 })
const AppTable = Table.make({
  schema: AppSchema,
  entities: { Fixtures, PlainFixtures, Readings },
})
const TestLayer = Layer.merge(InMemoryClient, AppTable.layer({ name: "edd133" }))

const fixtureInput = {
  id: "f1",
  team: "t1",
  kind: "match",
  when: dt,
  nullAt: dt,
  nullMs: dt,
  nullStamp: new Stamp({ at: dt }),
  arrNull: [dt, null],
  rec: { a: dt },
  tup: ["x", dt] as const,
  swr: { at: dt, note: "n" },
  xform: dt,
  days: [dt],
}

const mainItem = () =>
  [...store.values()].find((i) => i.__edd_e__?.S === "Fixture" && !i.sk?.S?.includes("#v#"))!

const db = DynamoClient.make({
  entities: { Fixtures, PlainFixtures, Readings },
  tables: { AppTable },
})

// ---------------------------------------------------------------------------
// Key bytes — captured before the #133 entity change, and pinned
// ---------------------------------------------------------------------------

describe("#133 entity nested self dates — keys are unchanged", () => {
  it.effect("put / update / soft delete compose the same keys", () =>
    Effect.gen(function* () {
      const client = yield* db
      yield* client.entities.Fixtures.put(fixtureInput as any)
      yield* client.entities.Fixtures.update({ id: "f1", when: dt } as any).set({
        kind: "final",
        nullAt: later,
      } as any)
      yield* client.entities.Fixtures.delete({ id: "f1", when: dt } as any)
      expect(keyLog()).toMatchInlineSnapshot(`
        [
          "Put item gsi1pk=$edd133#v1#fixture#kind_match",
          "Put item gsi1sk=$edd133#v1#fixture#when_2000-01-01t00:00:00.000z",
          "Put item gsi2pk=$edd133#v1#fixture#id_f1",
          "Put item gsi2sk=$edd133#v1#fixture#when_2000-01-01t00:00:00.000z",
          "Put item gsi3pk=$edd133#v1#fixture#team_t1",
          "Put item gsi3sk=$edd133#v1#fixture",
          "Put item pk=$edd133#v1#fixture#id_f1",
          "Put item sk=$edd133#v1#fixture#when_2000-01-01t00:00:00.000z",
          "Put item pk=$edd133#v1#fixture.kindwhen#match#2000-01-01t00:00:00.000z",
          "Put item sk=$edd133#v1#fixture.kindwhen",
          "Put item pk=$edd133#v1#fixture#id_f1",
          "Put item sk=$edd133#v1#fixture#v#0000001",
          "Put item gsi1pk=$edd133#v1#fixture#kind_final",
          "Put item gsi1sk=$edd133#v1#fixture#when_2000-01-01t00:00:00.000z",
          "Put item gsi2pk=$edd133#v1#fixture#id_f1",
          "Put item gsi2sk=$edd133#v1#fixture#when_2000-01-01t00:00:00.000z",
          "Put item gsi3pk=$edd133#v1#fixture#team_t1",
          "Put item gsi3sk=$edd133#v1#fixture",
          "Put item pk=$edd133#v1#fixture#id_f1",
          "Put item sk=$edd133#v1#fixture#when_2000-01-01t00:00:00.000z",
          "Put item pk=$edd133#v1#fixture#id_f1",
          "Put item sk=$edd133#v1#fixture#v#0000001",
          "Delete key pk=$edd133#v1#fixture.kindwhen#match#2000-01-01t00:00:00.000z",
          "Delete key sk=$edd133#v1#fixture.kindwhen",
          "Put item pk=$edd133#v1#fixture.kindwhen#final#2000-01-01t00:00:00.000z",
          "Put item sk=$edd133#v1#fixture.kindwhen",
          "Delete key pk=$edd133#v1#fixture#id_f1",
          "Delete key sk=$edd133#v1#fixture#when_2000-01-01t00:00:00.000z",
          "Put item pk=$edd133#v1#fixture#id_f1",
          "Put item sk=$edd133#v1#fixture#deleted#1970-01-01T00:00:00.000Z",
          "Put item pk=$edd133#v1#fixture#id_f1",
          "Put item sk=$edd133#v1#fixture#v#0000002",
          "Delete key pk=$edd133#v1#fixture.kindwhen#final#2000-01-01t00:00:00.000z",
          "Delete key sk=$edd133#v1#fixture.kindwhen",
        ]
      `)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a literal union composite keys on the literal", () =>
    Effect.gen(function* () {
      const client = yield* db
      yield* client.entities.Fixtures.put({ ...fixtureInput, id: "f2", when: "TBD" } as any)
      expect(keyLog()).toMatchInlineSnapshot(`
        [
          "Put item gsi1pk=$edd133#v1#fixture#kind_match",
          "Put item gsi1sk=$edd133#v1#fixture#when_tbd",
          "Put item gsi2pk=$edd133#v1#fixture#id_f2",
          "Put item gsi2sk=$edd133#v1#fixture#when_tbd",
          "Put item gsi3pk=$edd133#v1#fixture#team_t1",
          "Put item gsi3sk=$edd133#v1#fixture",
          "Put item pk=$edd133#v1#fixture#id_f2",
          "Put item sk=$edd133#v1#fixture#when_tbd",
          "Put item pk=$edd133#v1#fixture.kindwhen#match#tbd",
          "Put item sk=$edd133#v1#fixture.kindwhen",
          "Put item pk=$edd133#v1#fixture#id_f2",
          "Put item sk=$edd133#v1#fixture#v#0000001",
        ]
      `)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a plain UpdateItem recomposes the same GSI keys", () =>
    Effect.gen(function* () {
      const client = yield* db
      yield* client.entities.PlainFixtures.put({ ...fixtureInput, id: "p1" } as any)
      yield* client.entities.PlainFixtures.update({ id: "p1", when: dt } as any).set({
        kind: "final",
        nullAt: later,
      } as any)
      expect(keyLog()).toMatchInlineSnapshot(`
        [
          "Put item gsi1pk=$edd133#v1#plainfixture#kind_match",
          "Put item gsi1sk=$edd133#v1#plainfixture#when_2000-01-01t00:00:00.000z",
          "Put item pk=$edd133#v1#plainfixture#id_p1",
          "Put item sk=$edd133#v1#plainfixture#when_2000-01-01t00:00:00.000z",
          "Update key pk=$edd133#v1#plainfixture#id_p1",
          "Update key sk=$edd133#v1#plainfixture#when_2000-01-01t00:00:00.000z",
          "Update set gsi1pk=$edd133#v1#plainfixture#kind_final",
          "Update set gsi1sk=$edd133#v1#plainfixture#when_2000-01-01t00:00:00.000z",
        ]
      `)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a time-series append keys current and event items the same way", () =>
    Effect.gen(function* () {
      const client = yield* db
      // The mock does not apply UpdateItem, so the append's follow-up read
      // finds nothing; the writes it made are what is under test.
      yield* Effect.exit(
        Effect.gen(function* () {
          yield* client.entities.Readings.append({
            deviceId: "d1",
            at: dt,
            calibratedAt: dt,
          } as any)
        }),
      )
      expect(keyLog()).toMatchInlineSnapshot(`
        [
          "Update key pk=$edd133#v1#reading#deviceid_d1",
          "Update key sk=$edd133#v1#reading",
          "Put item pk=$edd133#v1#reading#deviceid_d1",
          "Put item sk=$edd133#v1#reading#e#2000-01-01t00:00:00.000z",
        ]
      `)
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// Stored form, reads, legacy rows and update values
// ---------------------------------------------------------------------------

/** Whether an attribute value holds a marshalled DateTime map anywhere. */
const holdsMarshalledDate = (value: unknown): boolean => {
  if (value === null || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  if ("epochMilliseconds" in record) return true
  return Object.values(record).some(holdsMarshalledDate)
}

const lastUpdateValues = (): ReadonlyArray<AttributeValue> => {
  const update = [...writes].reverse().find((w) => w.op === "Update")
  return Object.values((update?.input.ExpressionAttributeValues ?? {}) as Record<string, any>)
}

class Span extends Schema.Class<Span>("Span")({
  id: Schema.String,
  twr: Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Schema.DateTimeUtc]),
}) {}
const Spans = Entity.make({
  model: Span,
  entityType: "Span",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
})
const SpanTable = Table.make({ schema: AppSchema, entities: { Spans } })
const SpanLayer = Layer.merge(InMemoryClient, SpanTable.layer({ name: "edd133" }))

describe("#133 entity nested self dates — stored form and reads", () => {
  it.effect("put stores every nested self date in wire form", () =>
    Effect.gen(function* () {
      const client = yield* db
      yield* client.entities.Fixtures.put(fixtureInput as any)
      const item = mainItem()
      expect({
        when: item.when,
        nullAt: item.nullAt,
        nullMs: item.nullMs,
        nullStamp: item.nullStamp,
        arrNull: item.arrNull,
        rec: item.rec,
        tup: item.tup,
        swr: item.swr,
        xform: item.xform,
        days: item.days,
      }).toEqual({
        when: S(DOB),
        nullAt: S(DOB),
        nullMs: { N: String(DOB_MS) },
        nullStamp: { M: { at: S(DOB) } },
        arrNull: { L: [S(DOB), { NULL: true }] },
        rec: { M: { a: S(DOB) } },
        tup: { L: [S("x"), S(DOB)] },
        swr: { M: { at: S(DOB), note: S("n") } },
        xform: S(DOB),
        days: { L: [S(DOB)] },
      })
      // The version snapshot carries the same stored form.
      const snapshot = [...store.values()].find((i) => i.sk?.S?.includes("#v#"))!
      expect(holdsMarshalledDate(snapshot)).toBe(false)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("get reads real DateTime instances back", () =>
    Effect.gen(function* () {
      const client = yield* db
      yield* client.entities.Fixtures.put(fixtureInput as any)
      const got = (yield* client.entities.Fixtures.get({ id: "f1", when: dt } as any)) as any
      expect({
        when: isRealUtc(got.when, DOB_MS),
        nullAt: isRealUtc(got.nullAt, DOB_MS),
        nullMs: isRealUtc(got.nullMs, DOB_MS),
        nullStamp: got.nullStamp instanceof Stamp && isRealUtc(got.nullStamp.at, DOB_MS),
        arrNull: isRealUtc(got.arrNull[0], DOB_MS) && got.arrNull[1] === null,
        rec: isRealUtc(got.rec.a, DOB_MS),
        tup: isRealUtc(got.tup[1], DOB_MS),
        swr: isRealUtc(got.swr.at, DOB_MS) && got.swr.note === "n",
        xform: isRealUtc(got.xform, DOB_MS),
      }).toEqual({
        when: true,
        nullAt: true,
        nullMs: true,
        nullStamp: true,
        arrNull: true,
        rec: true,
        tup: true,
        swr: true,
        xform: true,
      })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("legacy marshalled maps on those paths read back as real DateTimes", () =>
    Effect.gen(function* () {
      const client = yield* db
      yield* client.entities.Fixtures.put(fixtureInput as any)
      const item = mainItem()
      item.nullAt = rcMap(DOB_MS)
      item.nullStamp = { M: { at: rcMap(DOB_MS) } }
      item.arrNull = { L: [rcMap(DOB_MS), { NULL: true }] }
      item.rec = { M: { a: rcMap(DOB_MS) } }
      item.tup = { L: [S("x"), rcMap(DOB_MS)] }
      item.swr = { M: { at: rcMap(DOB_MS), note: S("n") } }
      const got = (yield* client.entities.Fixtures.get({ id: "f1", when: dt } as any)) as any
      expect(isRealUtc(got.nullAt, DOB_MS)).toBe(true)
      expect(isRealUtc(got.nullStamp.at, DOB_MS)).toBe(true)
      expect(isRealUtc(got.arrNull[0], DOB_MS)).toBe(true)
      expect(isRealUtc(got.rec.a, DOB_MS)).toBe(true)
      expect(isRealUtc(got.tup[1], DOB_MS)).toBe(true)
      expect(isRealUtc(got.swr.at, DOB_MS)).toBe(true)
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("a TupleWithRest keeps its head element and encodes its rest", () =>
    Effect.gen(function* () {
      const client = yield* DynamoClient.make({ entities: { Spans }, tables: { SpanTable } })
      yield* client.entities.Spans.put({ id: "s1", twr: ["x", dt, later] } as any)
      const item = [...store.values()].find((i) => i.__edd_e__?.S === "Span")!
      expect(item.twr).toEqual({ L: [S("x"), S(DOB), S(LATER)] })
      const got = (yield* client.entities.Spans.get({ id: "s1" })) as any
      expect(got.twr[0]).toBe("x")
      expect(isRealUtc(got.twr[2], LATER_MS)).toBe(true)
    }).pipe(Effect.provide(SpanLayer)),
  )
})

describe("#133 entity nested self dates — update values", () => {
  it.effect(".set() encodes nested self dates", () =>
    Effect.gen(function* () {
      const client = yield* db
      yield* client.entities.PlainFixtures.put({ ...fixtureInput, id: "p1" } as any)
      yield* client.entities.PlainFixtures.update({ id: "p1", when: dt } as any).set({
        nullAt: later,
        rec: { b: later },
        tup: ["y", later],
        arrNull: [null, later],
      } as any)
      const values = lastUpdateValues()
      expect(values.some(holdsMarshalledDate)).toBe(false)
      expect(values).toContainEqual(S(LATER))
      expect(values).toContainEqual({ M: { b: S(LATER) } })
      expect(values).toContainEqual({ L: [S("y"), S(LATER)] })
      expect(values).toContainEqual({ L: [{ NULL: true }, S(LATER)] })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("path operations encode their value through the schema at the path", () =>
    Effect.gen(function* () {
      const client = yield* db
      yield* client.entities.PlainFixtures.put({ ...fixtureInput, id: "p1" } as any)
      yield* client.entities.PlainFixtures.update({ id: "p1", when: dt } as any)
        .pathSet({ segments: ["nullAt"], value: later, isPath: false })
        .pathSet({ segments: ["rec", "b"], value: later, isPath: false })
        .pathSet({ segments: ["nullStamp", "at"], value: later, isPath: false })
        .pathSet({ segments: ["days", 0], value: later, isPath: false })
        .pathAppend({ segments: ["arrNull"], value: [later, null] })
        .pathPrepend({ segments: ["days"], value: [later] })
        .pathIfNotExists({ segments: ["xform"], value: later })
      const values = lastUpdateValues()
      expect(values.some(holdsMarshalledDate)).toBe(false)
      expect(values).toContainEqual(S(LATER))
      expect(values).toContainEqual({ L: [S(LATER), { NULL: true }] })
      expect(values).toContainEqual({ L: [S(LATER)] })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("record-based append encodes its elements", () =>
    Effect.gen(function* () {
      const client = yield* db
      yield* client.entities.PlainFixtures.put({ ...fixtureInput, id: "p1" } as any)
      yield* client.entities.PlainFixtures.update({ id: "p1", when: dt } as any).append({
        days: [later],
        arrNull: [null, later],
      } as any)
      const values = lastUpdateValues()
      expect(values.some(holdsMarshalledDate)).toBe(false)
      expect(values).toContainEqual({ L: [S(LATER)] })
      expect(values).toContainEqual({ L: [{ NULL: true }, S(LATER)] })
    }).pipe(Effect.provide(TestLayer)),
  )

  it.effect("time-series append stores a nested self date in wire form", () =>
    Effect.gen(function* () {
      const client = yield* db
      yield* Effect.exit(
        Effect.gen(function* () {
          yield* client.entities.Readings.append({
            deviceId: "d1",
            at: dt,
            calibratedAt: dt,
          } as any)
        }),
      )
      const event = [...store.values()].find((i) => i.sk?.S?.includes("#e#"))!
      expect(event.calibratedAt).toEqual(S(DOB))
      const update = writes.find((w) => w.op === "Update")!
      const values = Object.values(update.input.ExpressionAttributeValues as Record<string, any>)
      expect(values.some(holdsMarshalledDate)).toBe(false)
    }).pipe(Effect.provide(TestLayer)),
  )
})

// ---------------------------------------------------------------------------
// Batch 3 — unions that mix a self date with a string / number member, path
// values already in wire form, configured storage on a union, legacy raw values
// ---------------------------------------------------------------------------

const makeEntityHolder = (
  name: string,
  field: Schema.Top,
  configured?: Record<string, unknown>,
  extra: Record<string, Schema.Top> = {},
) => {
  class Holder extends Schema.Class<Holder>(`EntityHolder-${name}`)({
    id: Schema.String,
    f: field as Schema.Codec<unknown>,
    ...(extra as Record<string, Schema.Codec<unknown>>),
  }) {}
  const model = configured === undefined ? Holder : DynamoModel.configure(Holder, configured as any)
  const Holders = Entity.make({
    model: model as any,
    entityType: "EntityHolder",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  })
  const HolderTable = Table.make({ schema: AppSchema, entities: { Holders } })
  return {
    client: DynamoClient.make({ entities: { Holders }, tables: { HolderTable } }),
    layer: Layer.merge(InMemoryClient, HolderTable.layer({ name: "edd133" })),
  }
}
const holderRow = (id: string) =>
  [...store.values()].find((i) => i.__edd_e__?.S === "EntityHolder" && i.id?.S === id)!
const plant = (id: string, attrs: Record<string, AttributeValue>) =>
  store.set(`$edd133#v1#entityholder#id_${id}|$edd133#v1#entityholder`, {
    pk: S(`$edd133#v1#entityholder#id_${id}`),
    sk: S("$edd133#v1#entityholder"),
    __edd_e__: S("EntityHolder"),
    id: S(id),
    ...attrs,
  })
const describeValue = (v: unknown): string =>
  DateTime.isDateTime(v)
    ? Object.getPrototypeOf(v) === Object.prototype
      ? "PLAIN"
      : `DT ${DateTime.formatIso(v)}`
    : JSON.stringify(v)

interface UnionCase {
  readonly name: string
  readonly schema: Schema.Top
  /** Rows as <= 1.22.0 stored them, and what each must read back as. */
  readonly legacy: ReadonlyArray<readonly [AttributeValue, string]>
  /** Fresh writes: value, stored attribute, read-back. */
  readonly fresh: ReadonlyArray<readonly [unknown, AttributeValue, string]>
}

const unionCases: ReadonlyArray<UnionCase> = [
  {
    name: "Union([DateTimeUtc, String])",
    schema: Schema.Union([Schema.DateTimeUtc, Schema.String]),
    legacy: [
      [S("2020"), '"2020"'],
      [S("5"), '"5"'],
      [S("hello"), '"hello"'],
      [rcMap(DOB_MS), `DT ${DOB}`],
    ],
    fresh: [
      ["2020", S("2020"), '"2020"'],
      ["5", S("5"), '"5"'],
      [dt, S(DOB), `DT ${DOB}`],
    ],
  },
  {
    name: "Union([String, DateTimeUtc])",
    schema: Schema.Union([Schema.String, Schema.DateTimeUtc]),
    legacy: [
      [S("2020"), '"2020"'],
      [rcMap(DOB_MS), `DT ${DOB}`],
    ],
    fresh: [
      ["2020", S("2020"), '"2020"'],
      [dt, S(DOB), `DT ${DOB}`],
    ],
  },
  {
    name: "NullOr(DateTimeUtc)",
    schema: Schema.NullOr(Schema.DateTimeUtc),
    legacy: [
      [rcMap(DOB_MS), `DT ${DOB}`],
      [{ NULL: true }, "null"],
    ],
    fresh: [
      [dt, S(DOB), `DT ${DOB}`],
      [null, { NULL: true }, "null"],
    ],
  },
]

describe("#133 entity nested self dates — unions with a colliding member", () => {
  for (const c of unionCases) {
    it.effect(`${c.name}: legacy rows and fresh writes read back as their own member`, () => {
      const { client, layer } = makeEntityHolder(c.name, c.schema)
      return Effect.gen(function* () {
        const db = yield* client
        const reads: Array<string> = []
        for (const [index, [stored]] of c.legacy.entries()) plant(`l${index}`, { f: stored })
        for (const [index] of c.legacy.entries()) {
          const got = (yield* db.entities.Holders.get({ id: `l${index}` })) as any
          reads.push(describeValue(got.f))
        }
        expect(reads).toEqual(c.legacy.map(([, read]) => read))

        const fresh: Array<string> = []
        for (const [index, [value, stored]] of c.fresh.entries()) {
          yield* db.entities.Holders.put({ id: `f${index}`, f: value } as any)
          expect(holderRow(`f${index}`).f).toEqual(stored)
          const got = (yield* db.entities.Holders.get({ id: `f${index}` })) as any
          fresh.push(describeValue(got.f))
        }
        expect(fresh).toEqual(c.fresh.map(([, , read]) => read))
      }).pipe(Effect.provide(layer))
    })
  }

  it.effect("a String value spelled exactly as a canonical ISO instant reads as the date", () => {
    // The one value the two members cannot be told apart by: documented decision.
    const { client, layer } = makeEntityHolder(
      "canonical",
      Schema.Union([Schema.DateTimeUtc, Schema.String]),
    )
    return Effect.gen(function* () {
      const db = yield* client
      yield* db.entities.Holders.put({ id: "c1", f: DOB } as any)
      const got = (yield* db.entities.Holders.get({ id: "c1" })) as any
      expect(describeValue(got.f)).toBe(`DT ${DOB}`)
    }).pipe(Effect.provide(layer))
  })
})

describe("#133 entity nested self dates — path values already in wire form", () => {
  class Address extends Schema.Class<Address>("PathAddress")({
    since: Schema.DateTimeUtc,
    n: Schema.NumberFromString,
  }) {}
  const { client, layer } = makeEntityHolder("wire", Schema.StringFromBase64, undefined, {
    json: Schema.fromJsonString(Schema.Unknown),
    b64s: Schema.Array(Schema.StringFromBase64),
    nfs: Schema.NumberFromString,
    xdate: Schema.DateTimeUtcFromString,
    secret: Schema.RedactedFromValue(Schema.String),
    addr: Address,
  })
  const input = {
    id: "w1",
    f: "hi",
    json: { a: 1 },
    b64s: ["hi"],
    nfs: 1,
    xdate: dt,
    secret: Redacted.make("s"),
    addr: new Address({ since: dt, n: 1 }),
  }
  const setValue = (segments: ReadonlyArray<string | number>, value: unknown) =>
    Effect.gen(function* () {
      const db = yield* client
      writes.length = 0
      yield* db.entities.Holders.update({ id: "w1" }).pathSet({ segments, value, isPath: false })
      return lastUpdateValues()
    })

  it.effect("passes ambiguous wire values through unchanged", () =>
    Effect.gen(function* () {
      const db = yield* client
      yield* db.entities.Holders.put(input as any)
      expect(yield* setValue(["f"], "aGk=")).toContainEqual(S("aGk="))
      expect(yield* setValue(["json"], '{"a":2}')).toContainEqual(S('{"a":2}'))
      expect(yield* setValue(["b64s"], ["aGk="])).toContainEqual({ L: [S("aGk=")] })
    }).pipe(Effect.provide(layer)),
  )

  it.effect("still encodes values that are unambiguously domain", () =>
    Effect.gen(function* () {
      const db = yield* client
      yield* db.entities.Holders.put(input as any)
      expect(yield* setValue(["nfs"], 5)).toContainEqual(S("5"))
      expect(yield* setValue(["nfs"], "6")).toContainEqual(S("6"))
      expect(yield* setValue(["xdate"], dt)).toContainEqual(S(DOB))
      expect(yield* setValue(["secret"], Redacted.make("z"))).toContainEqual(S("z"))
      expect(yield* setValue(["json"], { a: 3 })).toContainEqual(S('{"a":3}'))
      expect(yield* setValue(["addr"], new Address({ since: dt, n: 2 }))).toContainEqual({
        M: { since: S(DOB), n: S("2") },
      })
      expect(yield* setValue(["addr", "n"], 7)).toContainEqual(S("7"))
    }).pipe(Effect.provide(layer)),
  )
})

describe("#133 entity nested self dates — configured storage on a union field", () => {
  it.effect("DynamoModel.configure storedAs reaches the union's date member", () => {
    const { client, layer } = makeEntityHolder("configured", Schema.NullOr(Schema.DateTimeUtc), {
      f: { storedAs: DynamoModel.DateEpochMs },
    })
    return Effect.gen(function* () {
      const db = yield* client
      yield* db.entities.Holders.put({ id: "c1", f: dt } as any)
      expect(holderRow("c1").f).toEqual({ N: String(DOB_MS) })
      const got = (yield* db.entities.Holders.get({ id: "c1" })) as any
      expect(isRealUtc(got.f, DOB_MS)).toBe(true)
      writes.length = 0
      yield* db.entities.Holders.update({ id: "c1" }).pathSet({
        segments: ["f"],
        value: later,
        isPath: false,
      })
      expect(lastUpdateValues()).toContainEqual({ N: String(LATER_MS) })
    }).pipe(Effect.provide(layer))
  })

  it("rejects a configured storage override on a union with several date members", () => {
    expect(() =>
      makeEntityHolder("ambiguous", Schema.Union([Schema.DateTimeUtc, Schema.Date]), {
        f: { storedAs: DynamoModel.DateEpochMs },
      }),
    ).toThrow(/EDD-9057/)
  })
})

describe("#133 entity nested self dates — legacy raw values on transform fields", () => {
  class Box extends Schema.Class<Box>("LegacyBox")({ n: Schema.NumberFromString }) {}
  const { client, layer } = makeEntityHolder("legacy", Schema.NumberFromString, undefined, {
    big: Schema.BigIntFromString,
    xdate: Schema.DateTimeUtcFromString,
    box: Box,
    plainBig: Schema.BigInt,
    either: Schema.Union([Schema.BigIntFromString, Schema.Number]),
  })

  it.effect("reads values old path operations stored in their domain form", () =>
    Effect.gen(function* () {
      const db = yield* client
      plant("r1", {
        f: { N: "5" },
        big: { N: "7" },
        xdate: rcMap(DOB_MS),
        box: { M: { n: { N: "3" } } },
        plainBig: { N: "9" },
        either: { N: "4" },
      })
      const got = (yield* db.entities.Holders.get({ id: "r1" })) as any
      expect(got.f).toBe(5)
      expect(got.big).toBe(7n)
      expect(isRealUtc(got.xdate, DOB_MS)).toBe(true)
      expect(got.box.n).toBe(3)
      expect(got.plainBig).toBe(9n)
      // A union member never claims another member's value.
      expect(got.either).toBe(4)
    }).pipe(Effect.provide(layer)),
  )

  it.effect("keeps writing each transform's own wire form", () =>
    Effect.gen(function* () {
      const db = yield* client
      yield* db.entities.Holders.put({
        id: "r2",
        f: 5,
        big: 7n,
        xdate: dt,
        box: new Box({ n: 3 }),
        plainBig: 12345678901234567890n,
        either: 4,
      } as any)
      const row = holderRow("r2")
      expect(row.f).toEqual(S("5"))
      expect(row.big).toEqual(S("7"))
      expect(row.xdate).toEqual(S(DOB))
      expect(row.box).toEqual({ M: { n: S("3") } })
      expect(row.plainBig).toEqual({ N: "12345678901234567890" })
      const got = (yield* db.entities.Holders.get({ id: "r2" })) as any
      expect(got.plainBig).toBe(12345678901234567890n)
    }).pipe(Effect.provide(layer)),
  )
})

// ---------------------------------------------------------------------------
// Batch 4 — nested unions, zoned offsets, class path values, EDD-9058
// ---------------------------------------------------------------------------

const describeZoned = (v: unknown): string =>
  DateTime.isDateTime(v) && DateTime.isZoned(v)
    ? `ZONED ${DateTime.formatIsoZoned(v)}`
    : describeValue(v)

const nestedUnionCases: ReadonlyArray<UnionCase> = [
  {
    name: "Union([NullOr(DateTimeUtc), String])",
    schema: Schema.Union([Schema.NullOr(Schema.DateTimeUtc), Schema.String]),
    legacy: [
      [S("2020"), '"2020"'],
      [S("5"), '"5"'],
      [rcMap(DOB_MS), `DT ${DOB}`],
      [{ NULL: true }, "null"],
    ],
    fresh: [
      ["2020", S("2020"), '"2020"'],
      [dt, S(DOB), `DT ${DOB}`],
      [null, { NULL: true }, "null"],
    ],
  },
  {
    name: "Union([String, NullOr(DateTimeUtc)])",
    schema: Schema.Union([Schema.String, Schema.NullOr(Schema.DateTimeUtc)]),
    legacy: [
      [S("2020"), '"2020"'],
      [rcMap(DOB_MS), `DT ${DOB}`],
    ],
    fresh: [
      ["5", S("5"), '"5"'],
      [dt, S(DOB), `DT ${DOB}`],
    ],
  },
  {
    name: "Union([Union([DateTimeUtc, Literal(TBD)]), String])",
    schema: Schema.Union([
      Schema.Union([Schema.DateTimeUtc, Schema.Literal("TBD")]),
      Schema.String,
    ]),
    legacy: [
      [S("2020"), '"2020"'],
      [S("TBD"), '"TBD"'],
      [rcMap(DOB_MS), `DT ${DOB}`],
    ],
    fresh: [
      ["2020", S("2020"), '"2020"'],
      ["TBD", S("TBD"), '"TBD"'],
      [dt, S(DOB), `DT ${DOB}`],
    ],
  },
  {
    name: "NullOr(Union([DateTimeUtc, String]))",
    schema: Schema.NullOr(Schema.Union([Schema.DateTimeUtc, Schema.String])),
    legacy: [
      [S("2020"), '"2020"'],
      [rcMap(DOB_MS), `DT ${DOB}`],
      [{ NULL: true }, "null"],
    ],
    fresh: [
      ["2020", S("2020"), '"2020"'],
      [dt, S(DOB), `DT ${DOB}`],
      [null, { NULL: true }, "null"],
    ],
  },
]

describe("#133 entity nested self dates — nested unions with a colliding member", () => {
  for (const c of nestedUnionCases) {
    it.effect(`${c.name}: legacy rows and fresh writes read back as their own member`, () => {
      const { client, layer } = makeEntityHolder(c.name, c.schema)
      return Effect.gen(function* () {
        const db = yield* client
        const reads: Array<string> = []
        for (const [index, [stored]] of c.legacy.entries()) plant(`l${index}`, { f: stored })
        for (const [index] of c.legacy.entries()) {
          reads.push(
            describeValue(((yield* db.entities.Holders.get({ id: `l${index}` })) as any).f),
          )
        }
        expect(reads).toEqual(c.legacy.map(([, read]) => read))
        const fresh: Array<string> = []
        for (const [index, [value, stored]] of c.fresh.entries()) {
          yield* db.entities.Holders.put({ id: `f${index}`, f: value } as any)
          expect(holderRow(`f${index}`).f).toEqual(stored)
          fresh.push(
            describeValue(((yield* db.entities.Holders.get({ id: `f${index}` })) as any).f),
          )
        }
        expect(fresh).toEqual(c.fresh.map(([, , read]) => read))
      }).pipe(Effect.provide(layer))
    })
  }
})

describe("#133 entity nested self dates — zoned dates keep their zone", () => {
  const named = DateTime.makeZonedUnsafe(DOB_MS, { timeZone: "Europe/London" })
  const offset = DateTime.makeZonedUnsafe(DOB_MS, { timeZone: DateTime.zoneMakeOffset(5 * 3600e3) })
  const negative = DateTime.makeZonedUnsafe(DOB_MS, {
    timeZone: DateTime.zoneMakeOffset(-(3 * 3600e3 + 30 * 60e3)),
  })
  const utcZone = DateTime.makeZonedUnsafe(DOB_MS, { timeZone: "UTC" })

  for (const [label, schema] of [
    ["DateTimeZoned", Schema.DateTimeZoned],
    ["Union([DateTimeZoned, String])", Schema.Union([Schema.DateTimeZoned, Schema.String])],
  ] as const) {
    it.effect(`${label}: named, offset and UTC zones round-trip exactly`, () => {
      const { client, layer } = makeEntityHolder(`zoned-${label}`, schema)
      return Effect.gen(function* () {
        const db = yield* client
        for (const [index, value] of [named, offset, negative, utcZone].entries()) {
          yield* db.entities.Holders.put({ id: `z${index}`, f: value } as any)
          expect(holderRow(`z${index}`).f).toEqual(S(DateTime.formatIsoZoned(value)))
          const got = (yield* db.entities.Holders.get({ id: `z${index}` })) as any
          expect(describeZoned(got.f)).toBe(`ZONED ${DateTime.formatIsoZoned(value)}`)
        }
        if (label !== "DateTimeZoned") {
          yield* db.entities.Holders.put({ id: "s", f: "2020" } as any)
          expect(((yield* db.entities.Holders.get({ id: "s" })) as any).f).toBe("2020")
        }
      }).pipe(Effect.provide(layer))
    })
  }
})

describe("#133 entity nested self dates — class values set by path are encoded", () => {
  class Cred extends Schema.Class<Cred>("PathCred")({
    user: Schema.String,
    token: Schema.Redacted(Schema.String),
    issued: Schema.Date,
    at: Schema.DateTimeUtc,
  }) {}
  class Coded extends Schema.Class<Coded>("PathCoded")({
    code: Schema.StringFromBase64,
    at: Schema.DateTimeUtc,
  }) {}
  const { client, layer } = makeEntityHolder("cred", Cred, undefined, {
    creds: Schema.Array(Cred),
    plain: Schema.Struct({ at: Schema.DateTimeUtc, n: Schema.NumberFromString }),
    coded: Coded,
  })
  const cred = new Cred({
    user: "u",
    token: Redacted.make("secret"),
    issued: new Date(DOB_MS),
    at: dt,
  })
  const storedCred = { M: { user: S("u"), token: S("secret"), issued: S(DOB), at: S(DOB) } }
  const update = (f: (u: any) => any) =>
    Effect.gen(function* () {
      const db = yield* client
      writes.length = 0
      yield* f(db.entities.Holders.update({ id: "c" })) as Effect.Effect<unknown>
      return lastUpdateValues()
    })

  it.effect("pathSet / pathAppend of class instances and plain structs store wire form", () =>
    Effect.gen(function* () {
      const db = yield* client
      yield* db.entities.Holders.put({
        id: "c",
        f: cred,
        creds: [],
        plain: { at: dt, n: 1 },
        coded: new Coded({ code: "hi", at: dt }),
      } as any)
      expect(holderRow("c").f).toEqual(storedCred)
      expect(
        yield* update((u) => u.pathSet({ segments: ["f"], value: cred, isPath: false })),
      ).toContainEqual(storedCred)
      expect(
        yield* update((u) => u.pathAppend({ segments: ["creds"], value: [cred] })),
      ).toContainEqual({ L: [storedCred] })
      expect(
        yield* update((u) =>
          u.pathSet({ segments: ["plain"], value: { at: dt, n: 2 }, isPath: false }),
        ),
      ).toContainEqual({ M: { at: S(DOB), n: S("2") } })
      // A plain object given for a class-typed field is encoded as that class.
      expect(
        yield* update((u) =>
          u.pathSet({
            segments: ["f"],
            value: { user: "u", token: Redacted.make("secret"), issued: new Date(DOB_MS), at: dt },
            isPath: false,
          }),
        ),
      ).toContainEqual(storedCred)
      expect(
        yield* update((u) =>
          u.pathSet({
            segments: ["coded"],
            value: new Coded({ code: "hi", at: dt }),
            isPath: false,
          }),
        ),
      ).toContainEqual({ M: { code: S("aGk="), at: S(DOB) } })
    }).pipe(Effect.provide(layer)),
  )
})

describe("#133 entity nested self dates — epoch storage next to a number member", () => {
  for (const [label, other] of [
    ["Number", Schema.Number],
    ["Literal(0)", Schema.Literal(0)],
  ] as const) {
    it(`rejects Union([epoch date, ${label}]) at make() with EDD-9058`, () => {
      expect(() =>
        makeEntityHolder(
          `epoch-${label}`,
          Schema.Union([
            Schema.DateTimeUtc.pipe(DynamoModel.storedAs(DynamoModel.DateEpochMs)),
            other as Schema.Top,
          ]),
        ),
      ).toThrow(/EDD-9058[\s\S]*"f"/)
    })
  }

  it("rejects a configured epoch override on Union([date, Number]) with EDD-9058", () => {
    expect(() =>
      makeEntityHolder("epoch-configured", Schema.Union([Schema.DateTimeUtc, Schema.Number]), {
        f: { storedAs: DynamoModel.DateEpochSeconds },
      }),
    ).toThrow(/EDD-9058/)
  })

  it("accepts epoch storage next to a member stored as a string", () => {
    expect(() =>
      makeEntityHolder(
        "epoch-nfs",
        Schema.Union([
          Schema.DateTimeUtc.pipe(DynamoModel.storedAs(DynamoModel.DateEpochMs)),
          Schema.NumberFromString,
        ]),
      ),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Batch 5 — DynamoModel.DateTimeZoned offsets, mixed path values, epoch next
// to NumberFromString on an entity
// ---------------------------------------------------------------------------

describe("#133 entity nested self dates — DynamoModel.DateTimeZoned keeps offset zones", () => {
  it.effect("named and offset zones round-trip exactly", () => {
    const { client, layer } = makeEntityHolder("dm-zoned", DynamoModel.DateTimeZoned)
    return Effect.gen(function* () {
      const db = yield* client
      for (const [index, zone] of [
        "Europe/London",
        DateTime.zoneMakeOffset(5 * 3600e3),
        DateTime.zoneMakeOffset(-(3 * 3600e3 + 30 * 60e3)),
      ].entries()) {
        const value = DateTime.makeZonedUnsafe(DOB_MS, { timeZone: zone })
        yield* db.entities.Holders.put({ id: `z${index}`, f: value } as any)
        expect(holderRow(`z${index}`).f).toEqual(S(DateTime.formatIsoZoned(value)))
        const got = (yield* db.entities.Holders.get({ id: `z${index}` })) as any
        expect(DateTime.formatIsoZoned(got.f)).toBe(DateTime.formatIsoZoned(value))
      }
    }).pipe(Effect.provide(layer))
  })
})

describe("#133 entity nested self dates — path values mixing wire and domain leaves", () => {
  class Mixed extends Schema.Class<Mixed>("PathMixed")({
    b64: Schema.StringFromBase64,
    at: Schema.DateTimeUtc,
    n: Schema.NumberFromString,
    secret: Schema.Redacted(Schema.String),
    issued: Schema.Date,
  }) {}
  const MixedStruct = Schema.Struct({
    b64: Schema.StringFromBase64,
    at: Schema.DateTimeUtc,
    n: Schema.NumberFromString,
    secret: Schema.Redacted(Schema.String),
    issued: Schema.Date,
  })
  const { client, layer } = makeEntityHolder("mixed", MixedStruct, undefined, {
    cls: Mixed,
    list: Schema.Array(MixedStruct),
    byKey: Schema.Record(Schema.String, MixedStruct),
  })
  // `n` is already wire ("5") while `at` / `secret` / `issued` are domain, and
  // `b64` is a plain string — no whole-value encode or decode accepts this.
  const mixed = {
    b64: "hi",
    at: dt,
    n: "5",
    secret: Redacted.make("pw"),
    issued: new Date(DOB_MS),
  }
  const storedMixed = {
    // `"hi"` is not valid base64, so it is a domain value and is encoded.
    M: { b64: S("aGk="), at: S(DOB), n: S("5"), secret: S("pw"), issued: S(DOB) },
  }
  const update = (f: (u: any) => any) =>
    Effect.gen(function* () {
      const db = yield* client
      writes.length = 0
      yield* f(db.entities.Holders.update({ id: "m" })) as Effect.Effect<unknown>
      return lastUpdateValues()
    })

  it.effect("each leaf is put into its stored form", () =>
    Effect.gen(function* () {
      const db = yield* client
      const domain = { ...mixed, b64: "hi", n: 5 }
      yield* db.entities.Holders.put({
        id: "m",
        f: domain,
        cls: new Mixed(domain),
        list: [],
        byKey: {},
      } as any)
      for (const values of [
        yield* update((u) => u.pathSet({ segments: ["f"], value: mixed, isPath: false })),
        yield* update((u) => u.pathSet({ segments: ["cls"], value: mixed, isPath: false })),
      ]) {
        expect(values).toContainEqual(storedMixed)
        expect(values.some(holdsMarshalledDate)).toBe(false)
      }
      expect(
        yield* update((u) => u.pathAppend({ segments: ["list"], value: [mixed] })),
      ).toContainEqual({ L: [storedMixed] })
      expect(
        yield* update((u) =>
          u.pathSet({ segments: ["list"], value: [mixed, mixed], isPath: false }),
        ),
      ).toContainEqual({ L: [storedMixed, storedMixed] })
      expect(
        yield* update((u) =>
          u.pathSet({ segments: ["byKey"], value: { k: mixed }, isPath: false }),
        ),
      ).toContainEqual({ M: { k: storedMixed } })
      // A container that WOULD encode as a whole still leaves its ambiguous wire
      // leaf alone: `"aGk="` (valid base64 and a valid string) is passed through,
      // not base64-encoded again.
      const wholeEncodable = { ...mixed, b64: "aGk=", n: 5 }
      expect(
        yield* update((u) => u.pathSet({ segments: ["f"], value: wholeEncodable, isPath: false })),
      ).toContainEqual({ M: { ...storedMixed.M, b64: S("aGk=") } })
    }).pipe(Effect.provide(layer)),
  )
})

describe("#133 entity nested self dates — epoch date next to NumberFromString", () => {
  it.effect("is accepted on an entity and keeps each member", () => {
    const { client, layer } = makeEntityHolder(
      "epoch-nfs-roundtrip",
      Schema.Union([
        Schema.DateTimeUtc.pipe(DynamoModel.storedAs(DynamoModel.DateEpochSeconds)),
        Schema.NumberFromString,
      ]),
    )
    return Effect.gen(function* () {
      const db = yield* client
      yield* db.entities.Holders.put({ id: "a", f: 5 } as any)
      yield* db.entities.Holders.put({ id: "b", f: dt } as any)
      expect(holderRow("a").f).toEqual(S("5"))
      expect(holderRow("b").f).toEqual({ N: String(DOB_MS / 1000) })
      expect(((yield* db.entities.Holders.get({ id: "a" })) as any).f).toBe(5)
      expect(isRealUtc(((yield* db.entities.Holders.get({ id: "b" })) as any).f, DOB_MS)).toBe(true)
    }).pipe(Effect.provide(layer))
  })
})

// ---------------------------------------------------------------------------
// Batch 6 — container refinements are enforced on writes, not on reads; path
// values under an opaque DynamoModel.ref field
// ---------------------------------------------------------------------------

const ordered = Schema.makeFilter(
  (v: { readonly from: DateTime.Utc; readonly to: DateTime.Utc }) =>
    DateTime.toEpochMillis(v.from) <= DateTime.toEpochMillis(v.to) || "from must not be after to",
)
const Window = Schema.Struct({ from: Schema.DateTimeUtc, to: Schema.DateTimeUtc }).check(ordered)
class Slot extends Schema.Class<Slot>("CheckedSlot")(
  Schema.Struct({ from: Schema.DateTimeUtc, to: Schema.DateTimeUtc }).check(ordered),
) {}

describe("#133 entity nested self dates — container checks on writes", () => {
  const { client, layer } = makeEntityHolder(
    "checked",
    Schema.Array(Schema.DateTimeUtc).check(Schema.isMaxLength(2)),
    undefined,
    { window: Window, slot: Slot },
  )
  const valid = {
    id: "v",
    f: [dt],
    window: { from: dt, to: later },
    slot: new Slot({ from: dt, to: later }),
  }
  const failsValidation = (effect: Effect.Effect<unknown, unknown, any>) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(effect)
      expect((error as { _tag?: string })._tag).toBe("ValidationError")
    })

  it.effect(
    "put, set, path ops, Batch and Transaction reject a value breaking a container check",
    () =>
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Holders.put(valid as any)
        const holders = db.entities.Holders as any
        yield* failsValidation(holders.put({ ...valid, id: "a", f: [dt, dt, dt] }).asEffect())
        yield* failsValidation(
          holders.put({ ...valid, id: "b", window: { from: later, to: dt } }).asEffect(),
        )
        yield* failsValidation(
          holders.put({ ...valid, id: "c", slot: { from: later, to: dt } }).asEffect(),
        )
        yield* failsValidation(
          holders
            .update({ id: "v" })
            .set({ f: [dt, dt, dt] })
            .asEffect(),
        )
        yield* failsValidation(
          holders
            .update({ id: "v" })
            .set({ window: { from: later, to: dt } })
            .asEffect(),
        )
        yield* failsValidation(
          holders
            .update({ id: "v" })
            .pathSet({ segments: ["f"], value: [dt, dt, dt], isPath: false })
            .asEffect(),
        )
        yield* failsValidation(
          holders
            .update({ id: "v" })
            .pathSet({ segments: ["window"], value: { from: later, to: dt }, isPath: false })
            .asEffect(),
        )
        yield* failsValidation(
          holders
            .update({ id: "v" })
            .pathSet({ segments: ["slot"], value: { from: later, to: dt }, isPath: false })
            .asEffect(),
        )
        yield* failsValidation(Batch.write([holders.put({ ...valid, id: "d", f: [dt, dt, dt] })]))
        yield* failsValidation(
          Transaction.transactWrite([holders.put({ ...valid, id: "e", f: [dt, dt, dt] })]),
        )
        // Nothing was written by the rejected operations.
        expect(holderRow("a")).toBeUndefined()
        expect(holderRow("v").f).toEqual({ L: [S(DOB)] })
      }).pipe(Effect.provide(layer)),
  )

  it.effect("valid writes are unaffected", () =>
    Effect.gen(function* () {
      const db = yield* client
      yield* db.entities.Holders.put(valid as any)
      expect(holderRow("v").f).toEqual({ L: [S(DOB)] })
      writes.length = 0
      yield* db.entities.Holders.update({ id: "v" }).set({ f: [dt, later] } as any)
      expect(lastUpdateValues()).toContainEqual({ L: [S(DOB), S(LATER)] })
      writes.length = 0
      yield* db.entities.Holders.update({ id: "v" }).pathSet({
        segments: ["window"],
        value: { from: dt, to: dt },
        isPath: false,
      })
      expect(lastUpdateValues()).toContainEqual({ M: { from: S(DOB), to: S(DOB) } })
    }).pipe(Effect.provide(layer)),
  )

  it.effect("a stored row that breaks a container check still reads", () =>
    Effect.gen(function* () {
      const db = yield* client
      plant("old", {
        f: { L: [S(DOB), S(DOB), S(DOB)] },
        window: { M: { from: S(LATER), to: S(DOB) } },
        slot: { M: { from: S(LATER), to: S(DOB) } },
      })
      const got = (yield* db.entities.Holders.get({ id: "old" })) as any
      expect(got.f).toHaveLength(3)
      expect(isRealUtc(got.window.from, LATER_MS)).toBe(true)
      expect(got.slot).toBeInstanceOf(Slot)
    }).pipe(Effect.provide(layer)),
  )
})

describe("#133 entity nested self dates — path values under a DynamoModel.ref field", () => {
  class Author extends Schema.Class<Author>("RefAuthor")({
    authorId: Schema.String.pipe(DynamoModel.identifier),
    name: Schema.String,
    born: Schema.DateTimeUtc,
    secret: Schema.Redacted(Schema.String),
    rank: Schema.NumberFromString,
    awards: Schema.Array(Schema.DateTimeUtc),
  }) {}
  class Note extends Schema.Class<Note>("RefNote")({
    id: Schema.String,
    author: Author.pipe(DynamoModel.ref),
  }) {}
  const pk = {
    pk: { field: "pk", composite: [] as Array<string> },
    sk: { field: "sk", composite: [] },
  }
  const Authors = Entity.make({
    model: Author,
    entityType: "RefAuthor",
    primaryKey: { ...pk, pk: { field: "pk", composite: ["authorId"] } },
  })
  const Notes = Entity.make({
    model: Note,
    entityType: "RefNote",
    primaryKey: { ...pk, pk: { field: "pk", composite: ["id"] } },
    refs: { author: { entity: Authors } },
  })
  const RefTable = Table.make({ schema: AppSchema, entities: { Authors, Notes } })
  const refLayer = Layer.merge(InMemoryClient, RefTable.layer({ name: "edd133" }))
  const refClient = DynamoClient.make({ entities: { Authors, Notes }, tables: { RefTable } })
  const author = new Author({
    authorId: "a1",
    name: "Ann",
    born: dt,
    secret: Redacted.make("s"),
    rank: 1,
    awards: [dt],
  })
  const storedAuthor = (rank: string) => ({
    M: {
      authorId: S("a1"),
      name: S("Ann"),
      born: S(DOB),
      secret: S("s"),
      rank: S(rank),
      awards: { L: [S(DOB)] },
    },
  })
  const update = (f: (u: any) => any) =>
    Effect.gen(function* () {
      const db = yield* refClient
      writes.length = 0
      yield* f(db.entities.Notes.update({ id: "n1" })) as Effect.Effect<unknown>
      return lastUpdateValues()
    })

  it.effect("encodes values set into and under the ref field", () =>
    Effect.gen(function* () {
      const db = yield* refClient
      yield* db.entities.Authors.put(author as any)
      yield* db.entities.Notes.put({ id: "n1", authorId: "a1" } as any)
      const note = [...store.values()].find((i) => i.__edd_e__?.S === "RefNote")!
      expect(note.author).toEqual(storedAuthor("1"))

      expect(
        yield* update((u) =>
          u.pathSet({ segments: ["author", "born"], value: later, isPath: false }),
        ),
      ).toContainEqual(S(LATER))
      expect(
        yield* update((u) =>
          u.pathSet({ segments: ["author", "secret"], value: Redacted.make("t"), isPath: false }),
        ),
      ).toContainEqual(S("t"))
      expect(
        yield* update((u) => u.pathSet({ segments: ["author", "rank"], value: 7, isPath: false })),
      ).toContainEqual(S("7"))
      expect(
        yield* update((u) => u.pathAppend({ segments: ["author", "awards"], value: [later] })),
      ).toContainEqual({ L: [S(LATER)] })
      expect(
        yield* update((u) => u.pathIfNotExists({ segments: ["author", "born"], value: later })),
      ).toContainEqual(S(LATER))
      const whole = yield* update((u) =>
        u.pathSet({ segments: ["author"], value: author, isPath: false }),
      )
      expect(whole).toContainEqual(storedAuthor("1"))
      expect(whole.some(holdsMarshalledDate)).toBe(false)
    }).pipe(Effect.provide(refLayer)),
  )

  it.effect("legacy raw values under the ref field still read", () =>
    Effect.gen(function* () {
      const db = yield* refClient
      store.set("$edd133#v1#refnote#id_n2|$edd133#v1#refnote", {
        pk: S("$edd133#v1#refnote#id_n2"),
        sk: S("$edd133#v1#refnote"),
        __edd_e__: S("RefNote"),
        id: S("n2"),
        author: {
          M: {
            authorId: S("a1"),
            name: S("Ann"),
            born: rcMap(DOB_MS),
            secret: S("s"),
            rank: { N: "5" },
            awards: { L: [rcMap(DOB_MS)] },
          },
        },
      })
      const got = (yield* db.entities.Notes.get({ id: "n2" })) as any
      expect(isRealUtc(got.author.born, DOB_MS)).toBe(true)
      expect(got.author.rank).toBe(5)
      expect(isRealUtc(got.author.awards[0], DOB_MS)).toBe(true)
    }).pipe(Effect.provide(refLayer)),
  )
})

describe("#133 entity nested self dates — path values are validated as stored", () => {
  it.effect("an undefined optional key is dropped, not rejected", () => {
    const { client, layer } = makeEntityHolder(
      "optional-key",
      Schema.Struct({ at: Schema.DateTimeUtc, opt: Schema.optionalKey(Schema.DateTimeUtc) }),
    )
    return Effect.gen(function* () {
      const db = yield* client
      yield* db.entities.Holders.put({ id: "o", f: { at: dt } } as any)
      writes.length = 0
      yield* db.entities.Holders.update({ id: "o" }).pathSet({
        segments: ["f"],
        value: { at: later, opt: undefined },
        isPath: false,
      })
      expect(lastUpdateValues()).toContainEqual({ M: { at: S(LATER) } })
    }).pipe(Effect.provide(layer))
  })
})
