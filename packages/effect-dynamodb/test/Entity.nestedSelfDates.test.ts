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
import { DateTime, Effect, Equal, Layer, Schema } from "effect"
import { beforeEach } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
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
