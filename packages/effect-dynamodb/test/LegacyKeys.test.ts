/**
 * Rows still under their 1.36 keys (#171) — request capture.
 *
 * 1.37 composes some key text differently from 1.36 (numbers, sort key values
 * holding a character up to `%`, time-series event keys). While the fallback
 * is on — `DynamoSchema.make`'s `legacyKeys`, on by default — a single-item op
 * whose key text changed also reads, moves or deletes the item under its 1.36
 * key. These tests run the ops against a recording in-memory table:
 *
 * - **Zero overhead.** Every op over keys whose text did not change sends
 *   exactly the requests it sends with the fallback off.
 * - **The off switch.** With `legacyKeys: false`, no request names a 1.36 key,
 *   and an empty table answers every op as it does with the fallback on.
 * - **Changed keys.** The requests each op adds, in order, for an item under
 *   its 1.36 key; the move's Put recomposes each canonical GSI shape; and the
 *   extra requests are charged to the op's consumed-capacity report.
 *
 * `connected.legacy-keys.test.ts` runs the same ops against DynamoDB Local.
 */

import type { AttributeValue, BatchWriteItemCommandInput } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import * as KeyText136 from "@effect-dynamodb/schema/internal/KeyText136.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import * as Batch from "../src/Batch.js"
import * as ConsumedCapacity from "../src/ConsumedCapacity.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Expression from "../src/Expression.js"
import { fromAttributeMap, toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { clientLayer, collectReports, withConsumedCapacity } from "./helpers/CapacityMock.js"
import { makeRecordingTable, type Request } from "./helpers/RecordingTable.js"

// ---------------------------------------------------------------------------
// Fixtures — one set per schema: the fallback on, and off
// ---------------------------------------------------------------------------

class Meter extends Schema.Class<Meter>("Meter")({
  site: Schema.String,
  meterId: Schema.Number,
  serial: Schema.Number,
  zone: Schema.optional(Schema.String),
  reading: Schema.optional(Schema.Number),
  region: Schema.String,
  country: Schema.String,
  city: Schema.String,
  shelf: Schema.optional(Schema.String),
  bin: Schema.Number,
  status: Schema.String,
  label: Schema.String,
  deviceBinding: Schema.Number,
  note: Schema.optional(Schema.String),
}) {}

class Note extends Schema.Class<Note>("Note")({
  owner: Schema.String,
  title: Schema.String,
  body: Schema.String,
}) {}

class Doc extends Schema.Class<Doc>("Doc")({
  docId: Schema.Number,
  title: Schema.String,
}) {}

class Gauge extends Schema.Class<Gauge>("Gauge")({
  gaugeId: Schema.Number,
  at: Schema.Number,
  level: Schema.Number,
}) {}

const world = (schema: DynamoSchema.DynamoSchema) => {
  const Meters = Entity.make({
    model: Meter,
    entityType: "Meter",
    primaryKey: {
      pk: { field: "pk", composite: ["site"] },
      sk: { field: "sk", composite: ["meterId"] },
    },
    indexes: {
      // The six canonical GSI shapes (CLAUDE.md); 4 twice, preserved and sparse.
      byZone: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["zone"] },
        sk: { field: "gsi1sk", composite: ["reading"] },
      },
      byChannel: {
        name: "gsi2",
        pk: { field: "gsi2pk", composite: ["site"] },
        sk: { field: "gsi2sk", composite: ["meterId"] },
      },
      byPlace: {
        name: "gsi3",
        pk: { field: "gsi3pk", composite: ["region"] },
        sk: { field: "gsi3sk", composite: ["country", "city", "meterId"] },
      },
      byShelf: {
        name: "gsi4",
        pk: { field: "gsi4pk", composite: ["site"] },
        sk: { field: "gsi4sk", composite: ["shelf", "bin"] },
        indexPolicy: { pk: "preserve", sk: "preserve" },
      },
      byShelfSparse: {
        name: "gsi5",
        pk: { field: "gsi5pk", composite: ["site"] },
        sk: { field: "gsi5sk", composite: ["shelf", "bin"] },
        indexPolicy: { pk: "preserve", sk: "sparse" },
      },
      byStatus: {
        name: "gsi6",
        pk: { field: "gsi6pk", composite: ["status"] },
        sk: { field: "gsi6sk", composite: ["label"] },
      },
      byBinding: {
        name: "gsi7",
        pk: { field: "gsi7pk", composite: ["deviceBinding"] },
        sk: { field: "gsi7sk", composite: [] },
      },
    },
    unique: { serial: ["serial"] },
    timestamps: true,
    versioned: true,
  })
  const Notes = Entity.make({
    model: Note,
    entityType: "Note",
    primaryKey: {
      pk: { field: "pk", composite: ["owner"] },
      sk: { field: "sk", composite: ["title"] },
    },
  })
  const Docs = Entity.make({
    model: Doc,
    entityType: "Doc",
    primaryKey: {
      pk: { field: "pk", composite: ["docId"] },
      sk: { field: "sk", composite: [] },
    },
    timestamps: true,
    versioned: { retain: true },
    softDelete: true,
  })
  const Gauges = Entity.make({
    model: Gauge,
    entityType: "Gauge",
    primaryKey: {
      pk: { field: "pk", composite: ["gaugeId"] },
      sk: { field: "sk", composite: [] },
    },
    timeSeries: {
      orderBy: "at",
      appendInput: Schema.Struct({
        gaugeId: Schema.Number,
        at: Schema.Number,
        level: Schema.Number,
      }),
    },
  })
  const MainTable = Table.make({ schema, entities: { Meters, Notes, Docs, Gauges } })
  return { schema, Meters, Notes, Docs, Gauges, MainTable }
}

const On = world(DynamoSchema.make({ name: "unit136", version: 1 }))
const Off = world(DynamoSchema.make({ name: "unit136", version: 1, legacyKeys: false }))
type World = typeof On

const clientOf = (w: World) =>
  DynamoClient.make({
    entities: { Meters: w.Meters, Notes: w.Notes, Docs: w.Docs, Gauges: w.Gauges },
    tables: { MainTable: w.MainTable },
  })

/** Run `body` in `w` over a fresh recording table. */
const inTable = <A, E>(
  w: World,
  body: (table: ReturnType<typeof makeRecordingTable>) => Effect.Effect<A, E, any>,
) =>
  Effect.gen(function* () {
    const table = makeRecordingTable()
    const result = yield* body(table).pipe(
      Effect.provide(Layer.mergeAll(table.layer, w.MainTable.layer({ name: "t" }))),
    ) as Effect.Effect<A, E>
    return { table, result }
  })

/** Values whose key text 1.36 composed the same, and values whose text changed. */
const VALUES = {
  unchanged: {
    meterId: 7,
    serial: 1001,
    reading: 2,
    city: "sanjose",
    label: "ab",
    bin: 1,
    deviceBinding: 9,
    title: "newyork",
    docId: 5,
    gaugeId: 6,
  },
  changed: {
    meterId: -7,
    serial: -1001,
    reading: -2.5,
    city: "san jose",
    label: "a b",
    bin: -1,
    deviceBinding: -9,
    title: "new york",
    docId: -5,
    gaugeId: -6,
  },
} as const
type Values = (typeof VALUES)[keyof typeof VALUES]

const meterOf = (v: Values, site = "s") => ({
  site,
  meterId: v.meterId,
  serial: v.serial,
  reading: v.reading,
  region: "emea",
  country: "uk",
  city: v.city,
  bin: v.bin,
  status: "active",
  label: v.label,
  deviceBinding: v.deviceBinding,
})

const failureTag = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause) as { readonly _tag?: string }
  return error?._tag ?? "defect"
}

/** Every single-item op, its batch and transaction forms: each op's outcome. */
const script = (w: World, v: Values) =>
  Effect.gen(function* () {
    const db = yield* clientOf(w)
    const outcomes: Array<string> = []
    const run = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
      Effect.exit(effect).pipe(
        Effect.tap((exit) =>
          Effect.sync(() => {
            outcomes.push(`${name}: ${Exit.isSuccess(exit) ? "ok" : failureTag(exit.cause)}`)
          }),
        ),
      )
    const m = meterOf(v)
    const k = { site: "s", meterId: v.meterId }
    yield* run("put", db.entities.Meters.put(m).asEffect())
    yield* run("get", db.entities.Meters.get(k).asEffect())
    yield* run("get miss", db.entities.Meters.get({ site: "s", meterId: v.meterId * 3 }).asEffect())
    yield* run("create", db.entities.Meters.create(m).asEffect())
    yield* run("update", db.entities.Meters.update(k).set({ note: "u" }).asEffect())
    yield* run("patch", db.entities.Meters.patch(k).set({ note: "p" }).asEffect())
    yield* run("upsert", db.entities.Meters.upsert({ ...m, note: "x" }).asEffect())
    yield* run("delete", db.entities.Meters.delete(k).asEffect())
    yield* run("deleteIfExists", db.entities.Meters.deleteIfExists(k).asEffect())
    const n = { owner: "o", title: v.title, body: "b" }
    const n2 = { ...n, title: `${v.title}2` }
    yield* run("note put", db.entities.Notes.put(n).asEffect())
    yield* run(
      "note put cond",
      db.entities.Notes.put({ ...n, body: "b" })
        .condition({ body: "b" })
        .asEffect(),
    )
    yield* run("note create", db.entities.Notes.create(n).asEffect())
    yield* run("note consistent get", Entity.consistentRead(w.Notes.get(n)).asEffect())
    yield* run("batch get", Batch.get([w.Notes.get(n), w.Meters.get(k), w.Notes.get(n2)]))
    yield* run("batch write", Batch.write([w.Notes.put(n2), w.Notes.delete(n)]))
    yield* run("transact get", Transaction.transactGet([w.Notes.get(n2), w.Notes.get(n)]))
    yield* run(
      "transact write",
      Transaction.transactWrite([
        w.Notes.put(n),
        w.Notes.update(n2).pipe(Entity.set({ body: "t" })),
      ]),
    )
    yield* run(
      "transact check",
      Transaction.transactWrite([
        Transaction.check(w.Notes.get(n), Expression.condition({ eq: { body: "b" } })),
        w.Notes.delete(n2),
      ]),
    )
    yield* run("note delete", db.entities.Notes.delete(n).condition({ body: "b" }).asEffect())
    const d = { docId: v.docId }
    yield* run("doc put", db.entities.Docs.put({ ...d, title: "v1" }).asEffect())
    yield* run("doc update", db.entities.Docs.update(d).set({ title: "v2" }).asEffect())
    yield* run("doc getVersion", db.entities.Docs.getVersion(d, 1))
    yield* run("doc soft delete", db.entities.Docs.delete(d).asEffect())
    yield* run("doc deleted.get", db.entities.Docs.deleted.get(d))
    yield* run("doc restore", db.entities.Docs.restore(d))
    yield* run("doc purge", db.entities.Docs.purge(d))
    for (const at of [1, 2, 0]) {
      yield* run(
        `append ${at}`,
        db.entities.Gauges.append({ gaugeId: v.gaugeId, at, level: at }).asEffect(),
      )
    }
    return outcomes
  })

/** The requests, with each run's random incarnation tokens made equal. */
const normalized = (requests: ReadonlyArray<Request>) =>
  JSON.parse(
    JSON.stringify(requests).replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      "<token>",
    ),
  )

// ---------------------------------------------------------------------------
// Rows as 1.36 wrote them
// ---------------------------------------------------------------------------

type Keys = Record<string, string>
type Indexed = {
  readonly entityType: string
  readonly indexes: Record<string, any>
  readonly unique?: unknown
}

const keysOf = (w: World, entity: Indexed, record: Record<string, unknown>) => ({
  current: KeyComposer.composeIndexKeys(
    w.schema,
    entity.entityType,
    1,
    entity.indexes.primary,
    record,
  ) as Keys,
  old: KeyText136.composeIndexKeys(w.schema, entity.entityType, 1, entity.indexes.primary, record),
})

const sentinelKeys = (w: World, entityType: string, name: string, value: unknown) => {
  const current = DynamoSchema.composeUniqueKey(w.schema, entityType, name, [
    KeyComposer.serializeValue(value),
  ])
  const old = KeyText136.composeUniqueKey(w.schema, entityType, name, [value])
  return { current: { pk: current.pk, sk: current.sk }, old: { pk: old.pk, sk: old.sk } }
}

const at = (key: Keys) => `${key.pk}|${key.sk}`

/**
 * Rewrite the item at `record`'s key as 1.36 wrote it: its 1.36 primary key
 * and GSI key text (plus `extra`), its sentinels under their 1.36 keys.
 */
const demote = (
  table: ReturnType<typeof makeRecordingTable>,
  w: World,
  entity: Indexed,
  record: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => {
  const { current, old } = keysOf(w, entity, record)
  expect(old).not.toEqual(current)
  const item: Record<string, AttributeValue> = { ...table.items.get(at(current))! }
  expect(item.pk).toBeDefined()
  for (const [name, index] of Object.entries(entity.indexes)) {
    if (name === "primary") continue
    delete item[index.pk.field]
    delete item[index.sk.field]
  }
  const keys = KeyText136.composeAllKeys(w.schema, entity.entityType, 1, entity.indexes, record)
  table.items.delete(at(current))
  table.items.set(at(old), { ...item, ...toAttributeMap({ ...keys, ...extra }) })
  for (const [name, fields] of Object.entries(
    (entity.unique ?? {}) as Record<string, ReadonlyArray<string>>,
  )) {
    const sentinel = sentinelKeys(w, entity.entityType, name, record[fields[0]!])
    const held = table.items.get(at(sentinel.current))!
    table.items.delete(at(sentinel.current))
    table.items.set(at(sentinel.old), {
      ...held,
      ...toAttributeMap({ ...sentinel.old, _entity_pk: old.pk, _entity_sk: old.sk }),
    })
  }
  return { current, old }
}

/** Each request's command and the item keys it names, in order. */
const shape = (requests: ReadonlyArray<Request>) =>
  requests.map(({ command, input }) => {
    const keyText = (key: Record<string, AttributeValue> | undefined) =>
      key === undefined ? "?" : `${key.pk?.S}|${key.sk?.S}`
    switch (command) {
      case "TransactWriteItems":
        return `${command} ${(input.TransactItems as Array<any>)
          .map((item) => {
            const [kind, body] = Object.entries(item)[0] as [string, any]
            return `${kind} ${keyText(body.Item ?? body.Key)}`
          })
          .join(", ")}`
      case "TransactGetItems":
        return `${command} ${(input.TransactItems as Array<any>).map((item) => keyText(item.Get.Key)).join(", ")}`
      case "BatchGetItem":
        return `${command} ${Object.values(input.RequestItems as Record<string, any>)
          .flatMap((request) => request.Keys.map(keyText))
          .join(", ")}`
      case "BatchWriteItem":
        return `${command} ${Object.values(input.RequestItems as Record<string, any>)
          .flatMap((requests) =>
            requests.map((request: any) =>
              request.PutRequest !== undefined
                ? `Put ${keyText(request.PutRequest.Item)}`
                : `Delete ${keyText(request.DeleteRequest.Key)}`,
            ),
          )
          .join(", ")}`
      default:
        return `${command} ${keyText(input.Key ?? input.Item)}`
    }
  })

// ---------------------------------------------------------------------------
// Zero overhead and the off switch
// ---------------------------------------------------------------------------

describe("legacy keys — zero overhead and the off switch", () => {
  it.effect("keys whose text did not change: the same requests as with the fallback off", () =>
    Effect.gen(function* () {
      const on = yield* inTable(On, () => script(On, VALUES.unchanged))
      const off = yield* inTable(Off, () => script(Off, VALUES.unchanged))
      expect(on.result).toEqual(off.result)
      // The ops ran: not a vacuous comparison.
      expect(on.result.filter((o) => o.endsWith(": ok")).length).toBeGreaterThan(20)
      expect(on.table.requests.length).toBeGreaterThan(40)
      expect(normalized(on.table.requests)).toEqual(normalized(off.table.requests))
    }),
  )

  it.effect("legacyKeys: false: no request names a 1.36 key", () =>
    Effect.gen(function* () {
      const v = VALUES.changed
      const off = yield* inTable(Off, () => script(Off, v))
      // The parts of each key whose 1.36 text differs.
      const changed = (pair: { readonly current: Keys; readonly old: Keys }) =>
        Object.entries(pair.old).flatMap(([field, text]) =>
          text === pair.current[field] ? [] : [text],
        )
      const oldTexts = [
        ...changed(keysOf(Off, Off.Meters, meterOf(v))),
        ...changed(keysOf(Off, Off.Notes, { owner: "o", title: v.title })),
        ...changed(keysOf(Off, Off.Docs, { docId: v.docId })),
        ...changed(keysOf(Off, Off.Gauges, { gaugeId: v.gaugeId })),
        ...changed(sentinelKeys(Off, "Meter", "serial", v.serial)),
      ]
      expect(oldTexts).toHaveLength(5)
      const sent = JSON.stringify(off.table.requests)
      for (const text of oldTexts) expect(sent).not.toContain(text)
      // With nothing under a 1.36 key, the fallback changes no outcome.
      const on = yield* inTable(On, () => script(On, v))
      expect(on.result).toEqual(off.result)
      expect(JSON.stringify(on.table.requests)).toContain(oldTexts[0])
    }),
  )
})

// ---------------------------------------------------------------------------
// Changed keys: the requests each op adds
// ---------------------------------------------------------------------------

describe("legacy keys — an item under its 1.36 key", () => {
  const v = VALUES.changed
  const note = { owner: "o", title: v.title, body: "1.36" }
  const noteKey = { owner: "o", title: v.title }

  /** A table holding `note` as 1.36 wrote it. */
  const withNote = <A, E>(
    body: (
      table: ReturnType<typeof makeRecordingTable>,
      keys: { readonly current: Keys; readonly old: Keys },
    ) => Effect.Effect<A, E, any>,
  ) =>
    inTable(On, (table) =>
      Effect.gen(function* () {
        const db = yield* clientOf(On)
        yield* db.entities.Notes.put(note).asEffect()
        const keys = demote(table, On, On.Notes, note)
        table.take()
        return yield* body(table, keys)
      }),
    )

  it.effect("get reads the current key, then the 1.36 key, consistently when asked", () =>
    Effect.gen(function* () {
      yield* withNote((table, { current, old }) =>
        Effect.gen(function* () {
          const db = yield* clientOf(On)
          expect((yield* db.entities.Notes.get(noteKey).asEffect()).body).toBe("1.36")
          expect(shape(table.take())).toEqual([`GetItem ${at(current)}`, `GetItem ${at(old)}`])
          yield* Entity.consistentRead(On.Notes.get(noteKey)).asEffect()
          const reads = table.take()
          expect(reads.map((r) => r.input.ConsistentRead)).toEqual([true, true])
          // Nothing moved.
          expect(table.items.has(at(old))).toBe(true)
          expect(table.items.has(at(current))).toBe(false)
        }),
      )
    }),
  )

  it.effect("put: one transaction — Put at the current key, Delete at the 1.36 key", () =>
    Effect.gen(function* () {
      yield* withNote((table, { current, old }) =>
        Effect.gen(function* () {
          const db = yield* clientOf(On)
          yield* db.entities.Notes.put({ ...note, body: "1.37" }).asEffect()
          expect(shape(table.take())).toEqual([
            `TransactWriteItems Put ${at(current)}, Delete ${at(old)}`,
          ])
          expect(table.items.has(at(old))).toBe(false)
        }),
      )
    }),
  )

  it.effect("put: a transaction a concurrent one cancelled is sent again", () =>
    Effect.gen(function* () {
      yield* withNote((table, { current, old }) =>
        Effect.gen(function* () {
          let conflicts = 2
          const client = yield* DynamoClient
          const conflicted = Layer.succeed(DynamoClient, {
            ...client,
            transactWriteItems: (input) =>
              conflicts-- > 0
                ? Effect.fail(
                    new DynamoError({
                      operation: "TransactWriteItems",
                      cause: Object.assign(new Error("Transaction cancelled"), {
                        name: "TransactionCanceledException",
                        CancellationReasons: [{ Code: "TransactionConflict" }, { Code: "None" }],
                      }),
                    }),
                  )
                : client.transactWriteItems(input),
          })
          const db = yield* clientOf(On).pipe(Effect.provide(conflicted))
          yield* db.entities.Notes.put({ ...note, body: "1.37" }).asEffect()
          expect(shape(table.take())).toEqual([
            `TransactWriteItems Put ${at(current)}, Delete ${at(old)}`,
          ])
          expect(conflicts).toBe(-1)
          expect(table.items.has(at(old))).toBe(false)
        }),
      )
    }),
  )

  it.effect("create: the 1.36 key must be empty too", () =>
    Effect.gen(function* () {
      yield* withNote((table, { current, old }) =>
        Effect.gen(function* () {
          const db = yield* clientOf(On)
          const err = yield* db.entities.Notes.create(note).asEffect().pipe(Effect.flip)
          expect(err._tag).toBe("ConditionalCheckFailed")
          const [sent] = table.take()
          expect(shape([sent!])).toEqual([
            `TransactWriteItems Put ${at(current)}, ConditionCheck ${at(old)}`,
          ])
          expect(sent!.input.TransactItems[1].ConditionCheck.ConditionExpression).toBe(
            "attribute_not_exists(#pk)",
          )
        }),
      )
    }),
  )

  it.effect("a conditioned put is sent first; a miss moves the item, then judges it there", () =>
    Effect.gen(function* () {
      yield* withNote((table, { current, old }) =>
        Effect.gen(function* () {
          const db = yield* clientOf(On)
          yield* db.entities.Notes.put({ ...note, body: "x" })
            .condition({ body: "1.36" })
            .asEffect()
          const sent = table.take()
          expect(shape(sent)).toEqual([
            `PutItem ${at(current)}`,
            `GetItem ${at(old)}`,
            `TransactWriteItems Put ${at(current)}, Delete ${at(old)}`,
            `PutItem ${at(current)}`,
          ])
          // The first attempt requires the item at its current key — and,
          // `new york` holding a space, that the row there holds one too.
          expect(sent[0]!.input.ConditionExpression).toBe(
            "(#e0 = :e1) AND attribute_exists(#mvpk) AND (contains(#al0, :al0))",
          )
          expect(sent[0]!.input.ReturnValuesOnConditionCheckFailure).toBe("ALL_OLD")
          expect(sent[1]!.input.ConsistentRead).toBe(true)
          const move = sent[2]!.input.TransactItems
          expect(move[0].Put.ConditionExpression).toBe("attribute_not_exists(#pk)")
          // The Delete is guarded on the item read: every attribute, unversioned.
          expect(move[1].Delete.ConditionExpression).toContain("#")
          expect(sent[3]!.input.ConditionExpression).toBe(
            "(#e0 = :e1) AND (attribute_not_exists(#mvpk) OR (contains(#al0, :al0)))",
          )
          // Moved: the next conditioned put is one PutItem.
          yield* db.entities.Notes.put({ ...note, body: "y" })
            .condition({ body: "x" })
            .asEffect()
          expect(shape(table.take())).toEqual([`PutItem ${at(current)}`])
        }),
      )
    }),
  )

  it.effect("update: a miss at the current key moves the item, then updates it", () =>
    Effect.gen(function* () {
      yield* withNote((table, { current, old }) =>
        Effect.gen(function* () {
          const db = yield* clientOf(On)
          const updated = yield* db.entities.Notes.update(noteKey).set({ body: "u" }).asEffect()
          expect(updated.body).toBe("u")
          const sent = table.take()
          expect(shape(sent)).toEqual([
            `UpdateItem ${at(current)}`,
            `GetItem ${at(old)}`,
            `TransactWriteItems Put ${at(current)}, Delete ${at(old)}`,
            `UpdateItem ${at(current)}`,
          ])
          // The first attempt asks for the stored item on a failed condition:
          // no item there is the miss, without another read.
          expect(sent[0]!.input.ReturnValuesOnConditionCheckFailure).toBe("ALL_OLD")
          expect(table.items.has(at(old))).toBe(false)
          expect(fromAttributeMap(table.items.get(at(current))!).body).toBe("u")
        }),
      )
    }),
  )

  it.effect("delete: the current key, then the 1.36 key", () =>
    Effect.gen(function* () {
      yield* withNote((table, { current, old }) =>
        Effect.gen(function* () {
          const db = yield* clientOf(On)
          yield* db.entities.Notes.delete(noteKey).asEffect()
          expect(shape(table.take())).toEqual([
            `DeleteItem ${at(current)}`,
            `DeleteItem ${at(old)}`,
          ])
          expect(table.items.has(at(old))).toBe(false)
        }),
      )
    }),
  )

  it.effect("batches: one more BatchGetItem for the misses; writes delete the 1.36 key", () =>
    Effect.gen(function* () {
      yield* withNote((table, { current, old }) =>
        Effect.gen(function* () {
          const [got] = yield* Batch.get([On.Notes.get(noteKey)])
          expect(got?.body).toBe("1.36")
          expect(shape(table.take())).toEqual([
            `BatchGetItem ${at(current)}`,
            `BatchGetItem ${at(old)}`,
          ])
          // `new york` holds a space: another value's 1.36 row can share its
          // keys (`new%20york`'s), so each is read before the batch deletes it.
          // The 1.36 key is deleted once the put is written, never beside it.
          yield* Batch.write([On.Notes.put({ ...note, body: "b" })])
          expect(shape(table.take())).toEqual([
            `GetItem ${at(current)}`,
            `GetItem ${at(old)}`,
            `BatchWriteItem Put ${at(current)}`,
            `BatchWriteItem Delete ${at(old)}`,
          ])
          yield* Batch.write([On.Notes.delete(noteKey)])
          expect(shape(table.take())).toEqual([
            `GetItem ${at(current)}`,
            `GetItem ${at(old)}`,
            `BatchWriteItem Delete ${at(current)}, Delete ${at(old)}`,
          ])
        }),
      )
    }),
  )

  it.effect("Batch.write: a put left unprocessed leaves the item at its 1.36 key", () =>
    Effect.gen(function* () {
      yield* withNote((table, { current, old }) =>
        Effect.gen(function* () {
          // DynamoDB processes the deletes and leaves every put unprocessed.
          const client = yield* DynamoClient
          const only = (
            requests: NonNullable<BatchWriteItemCommandInput["RequestItems"]>,
            kind: "PutRequest" | "DeleteRequest",
          ) =>
            Object.fromEntries(
              Object.entries(requests)
                .map(
                  ([name, items]) =>
                    [name, (items ?? []).filter((item) => item[kind] !== undefined)] as const,
                )
                .filter(([, items]) => items.length > 0),
            )
          const unprocessed = Layer.succeed(DynamoClient, {
            ...client,
            batchWriteItem: (input) => {
              const deletes = only(input.RequestItems ?? {}, "DeleteRequest")
              return (
                Object.keys(deletes).length > 0
                  ? client.batchWriteItem({ RequestItems: deletes })
                  : Effect.void
              ).pipe(
                Effect.as({
                  UnprocessedItems: only(input.RequestItems ?? {}, "PutRequest"),
                  $metadata: {},
                }),
              )
            },
          })
          const error = yield* Batch.write([On.Notes.put({ ...note, body: "b" })], {
            maxRetries: 0,
            baseDelayMs: 0,
          }).pipe(Effect.provide(unprocessed), Effect.flip)
          expect(error._tag).toBe("DynamoError")
          expect(table.items.has(at(old))).toBe(true)
          expect(table.items.has(at(current))).toBe(false)
        }),
      )
    }),
  )

  it.effect("transactGet: a second TransactGetItems for the misses", () =>
    Effect.gen(function* () {
      yield* withNote((table, { current, old }) =>
        Effect.gen(function* () {
          const [got] = yield* Transaction.transactGet([On.Notes.get(noteKey)])
          expect(got?.body).toBe("1.36")
          expect(shape(table.take())).toEqual([
            `TransactGetItems ${at(current)}`,
            `TransactGetItems ${at(old)}`,
          ])
        }),
      )
    }),
  )

  it.effect("transactWrite: create checks the 1.36 key; put and delete delete it", () =>
    Effect.gen(function* () {
      yield* withNote((table, { current, old }) =>
        Effect.gen(function* () {
          const created = yield* Transaction.transactWrite([On.Notes.create(note)]).pipe(
            Effect.flip,
          )
          expect(created._tag).toBe("TransactionCancelled")
          // `new york` holds a space: another value's 1.36 row can share its
          // keys (`new%20york`'s), so each is read before the transaction.
          const checked = [`GetItem ${at(current)}`, `GetItem ${at(old)}`]
          expect(shape(table.take())).toEqual([
            ...checked,
            `TransactWriteItems Put ${at(current)}, ConditionCheck ${at(old)}`,
          ])
          yield* Transaction.transactWrite([On.Notes.put({ ...note, body: "t" })])
          expect(shape(table.take())).toEqual([
            ...checked,
            `TransactWriteItems Put ${at(current)}, Delete ${at(old)}`,
          ])
          yield* Transaction.transactWrite([On.Notes.delete(noteKey)])
          expect(shape(table.take())).toEqual([
            ...checked,
            `TransactWriteItems Delete ${at(current)}, Delete ${at(old)}`,
          ])
        }),
      )
    }),
  )

  it.effect(
    "transactWrite: an update of an unmoved item fails ItemNotMoved, sending no write",
    () =>
      Effect.gen(function* () {
        yield* withNote((table, { old }) =>
          Effect.gen(function* () {
            const err = yield* Transaction.transactWrite([
              On.Notes.update(noteKey).pipe(Entity.set({ body: "x" })),
            ]).pipe(Effect.flip)
            expect(err._tag).toBe("ItemNotMoved")
            expect(err.message).toMatch(/^\[EDD-9097\] /)
            const sent = table.take()
            expect(sent.map((r) => r.command)).not.toContain("TransactWriteItems")
            expect(table.items.has(at(old))).toBe(true)
            // A conditioned put checks the item moved, in the transaction.
            const conditioned = yield* Transaction.transactWrite([
              On.Notes.put({ ...note, body: "y" }).pipe(
                On.Notes.condition({ eq: { body: "1.36" } }),
              ),
            ]).pipe(Effect.flip)
            expect(conditioned._tag).toBe("ItemNotMoved")
          }),
        )
      }),
  )

  it.effect("the move recomposes every canonical GSI shape and moves the sentinel", () =>
    inTable(On, (table) =>
      Effect.gen(function* () {
        const db = yield* clientOf(On)
        const record = meterOf(v)
        yield* db.entities.Meters.put(record).asEffect()
        const { current, old } = demote(table, On, On.Meters, record, {
          gsi1sk: KeyText136.composeSk(On.schema, "Meter", 1, On.Meters.indexes.byZone, record),
          gsi4pk: "stale-4pk",
          gsi4sk: "stale-4sk",
          gsi5pk: "stale-5pk",
          gsi5sk: "stale-5sk",
        })
        table.take()
        yield* db.entities.Meters.update({ site: "s", meterId: v.meterId })
          .set({ note: "moved" })
          .asEffect()
        const sentinel = sentinelKeys(On, "Meter", "serial", v.serial)
        const sent = table.take()
        expect(shape(sent)).toEqual([
          `UpdateItem ${at(current)}`,
          `GetItem ${at(old)}`,
          `GetItem ${at(sentinel.old)}`,
          `TransactWriteItems Put ${at(current)}, Delete ${at(old)}, Put ${at(sentinel.current)}, Delete ${at(sentinel.old)}`,
          `UpdateItem ${at(current)}`,
        ])
        const move = sent[3]!.input.TransactItems
        const moved = fromAttributeMap(move[0].Put.Item)
        const index = On.Meters.indexes
        // The versioned item's Delete is guarded on its version and incarnation.
        expect(move[1].Delete.ConditionExpression).toContain("#")
        // 1. Multi-writer: the half the item holds composites for, recomposed.
        expect(moved.gsi1pk).toBeUndefined()
        expect(moved.gsi1sk).toBe(
          KeyComposer.composeSk(On.schema, "Meter", 1, index.byZone, record),
        )
        // 2, 3, 5 and 6: recomposed in their 1.37 text.
        for (const name of ["byChannel", "byPlace", "byStatus", "byBinding"] as const) {
          const keys = KeyComposer.composeIndexKeys(On.schema, "Meter", 1, index[name], record)
          for (const [field, value] of Object.entries(keys)) expect(moved[field], name).toBe(value)
        }
        // 4. Hole: the partition half recomposed; the sort half kept under
        // 'preserve', removed under 'sparse'.
        expect(moved.gsi4pk).toBe(KeyComposer.composePk(On.schema, "Meter", index.byShelf, record))
        expect(moved.gsi4sk).toBe("stale-4sk")
        expect(moved.gsi5pk).toBe(
          KeyComposer.composePk(On.schema, "Meter", index.byShelfSparse, record),
        )
        expect(moved.gsi5sk).toBeUndefined()
        // The sentinel follows the item.
        expect(fromAttributeMap(move[2].Put.Item)).toMatchObject({
          _entity_pk: current.pk,
          _entity_sk: current.sk,
        })
        expect(table.items.has(at(sentinel.old))).toBe(false)
      }),
    ),
  )

  it.effect("fallback reads and moves are charged to the op's capacity report", () =>
    Effect.gen(function* () {
      const table = makeRecordingTable()
      const { service } = withConsumedCapacity(table.client)
      const { reports, onOperation } = collectReports()
      const layer = Layer.mergeAll(
        clientLayer(service),
        On.MainTable.layer({ name: "t" }),
        ConsumedCapacity.layer({ onOperation }),
      )
      yield* Effect.gen(function* () {
        const db = yield* clientOf(On)
        yield* db.entities.Notes.put(note).asEffect()
        demote(table, On, On.Notes, note)
        reports.length = 0
        yield* db.entities.Notes.get(noteKey).asEffect()
        yield* db.entities.Notes.update(noteKey).set({ body: "u" }).asEffect()
      }).pipe(Effect.provide(layer))
      expect(reports.map((r) => r.requestsByCommand)).toEqual([
        { GetItem: 2 },
        { UpdateItem: 2, GetItem: 1, TransactWriteItems: 1 },
      ])
      expect(reports[0]!.capacityUnits).toBe(1)
    }),
  )
})

// ---------------------------------------------------------------------------
// Retained history: the snapshot of the item's version moves with it
// ---------------------------------------------------------------------------

/** A snapshot's version: `versions()` returns the model, which doesn't declare it. */
const versionOf = (item: unknown) => (item as { readonly version: number }).version

describe("legacy keys — a retained item's snapshot of its version", () => {
  const key = { docId: VALUES.changed.docId }
  const pkNow = KeyComposer.composePk(On.schema, "Doc", On.Docs.indexes.primary, key)
  const pk136 = KeyText136.composePk(On.schema, "Doc", On.Docs.indexes.primary, key)
  const sk = KeyComposer.composeSk(On.schema, "Doc", 1, On.Docs.indexes.primary, key)
  // No sort key composites: one item per partition, no item segment (#133).
  const snapshotSk = (version: number) => DynamoSchema.composeVersionKey(On.schema, "Doc", version)

  /** Move every row of the doc's partition — item, snapshots, tombstones — under its 1.36 key. */
  const demoteDoc = (table: ReturnType<typeof makeRecordingTable>) => {
    let moved = 0
    for (const [k, row] of [...table.items.entries()]) {
      if (row.pk?.S !== pkNow) continue
      table.items.delete(k)
      table.items.set(`${pk136}|${row.sk?.S}`, { ...row, pk: { S: pk136 } })
      moved++
    }
    expect(moved).toBeGreaterThan(0)
  }
  const rowsUnder = (table: ReturnType<typeof makeRecordingTable>, pk: string) =>
    [...table.items.values()]
      .filter((row) => row.pk?.S === pk)
      .map((row) => row.sk?.S)
      .sort()

  /** A doc 1.36 put once: the item at version 1 and its version 1 snapshot, under its 1.36 key. */
  const withPutDoc = <A, E>(
    body: (table: ReturnType<typeof makeRecordingTable>) => Effect.Effect<A, E, any>,
  ) =>
    inTable(On, (table) =>
      Effect.gen(function* () {
        const db = yield* clientOf(On)
        yield* db.entities.Docs.put({ ...key, title: "v1" }).asEffect()
        demoteDoc(table)
        expect(rowsUnder(table, pk136)).toEqual([sk, snapshotSk(1)])
        table.take()
        return yield* body(table)
      }),
    )

  const writes = {
    put: (db: Effect.Success<ReturnType<typeof clientOf>>) =>
      db.entities.Docs.put({ ...key, title: "v2" }).asEffect(),
    update: (db: Effect.Success<ReturnType<typeof clientOf>>) =>
      db.entities.Docs.update(key).set({ title: "v2" }).asEffect(),
    patch: (db: Effect.Success<ReturnType<typeof clientOf>>) =>
      db.entities.Docs.patch(key).set({ title: "v2" }).asEffect(),
    upsert: (db: Effect.Success<ReturnType<typeof clientOf>>) =>
      db.entities.Docs.upsert({ ...key, title: "v2" }).asEffect(),
    "soft delete": (db: Effect.Success<ReturnType<typeof clientOf>>) =>
      db.entities.Docs.delete(key).asEffect(),
  } as const

  for (const [name, write] of Object.entries(writes)) {
    it.effect(`${name}: the move takes the version 1 snapshot along; no version twice`, () =>
      withPutDoc((table) =>
        Effect.gen(function* () {
          const db = yield* clientOf(On)
          yield* write(db)
          const move = shape(table.take()).filter((s) => s.startsWith("TransactWriteItems Put"))[0]
          expect(move).toBe(
            `TransactWriteItems Put ${pkNow}|${sk}, Delete ${pk136}|${sk}, ` +
              `Put ${pkNow}|${snapshotSk(1)}, Delete ${pk136}|${snapshotSk(1)}`,
          )
          expect(rowsUnder(table, pk136)).toEqual([])
          const versions = yield* db.entities.Docs.versions(key).collect()
          // Version 1, once; version 2 is the item's, not yet snapshotted.
          expect(versions.map((d) => [versionOf(d), d.title])).toEqual([[1, "v1"]])
        }),
      ),
    )
  }

  it.effect("restore moves the snapshot of the version it restores, then restores", () =>
    inTable(On, (table) =>
      Effect.gen(function* () {
        const db = yield* clientOf(On)
        yield* db.entities.Docs.put({ ...key, title: "v1" }).asEffect()
        yield* db.entities.Docs.delete(key).asEffect()
        demoteDoc(table)
        table.take()
        const restored = yield* db.entities.Docs.restore(key)
        expect(restored.title).toBe("v1")
        expect(shape(table.take())).toContain(
          `TransactWriteItems Put ${pkNow}|${snapshotSk(1)}, Delete ${pk136}|${snapshotSk(1)}`,
        )
        expect(rowsUnder(table, pk136)).toEqual([])
        const versions = yield* db.entities.Docs.versions(key).collect()
        expect(versions.map((d) => [versionOf(d), d.title])).toEqual([[1, "v1"]])
      }),
    ),
  )

  it.effect("older versions' snapshots stay under the 1.36 key", () =>
    inTable(On, (table) =>
      Effect.gen(function* () {
        const db = yield* clientOf(On)
        yield* db.entities.Docs.put({ ...key, title: "v1" }).asEffect()
        yield* db.entities.Docs.update(key).set({ title: "v2" }).asEffect()
        yield* db.entities.Docs.update(key).set({ title: "v3" }).asEffect()
        demoteDoc(table)
        table.take()
        yield* db.entities.Docs.update(key).set({ title: "v4" }).asEffect()
        // At version 3, which the item's own update snapshotted: only that one moves.
        expect(rowsUnder(table, pk136)).toEqual([snapshotSk(1), snapshotSk(2)])
        const versions = yield* db.entities.Docs.versions(key).collect()
        expect(versions.map((d) => [versionOf(d), d.title])).toEqual([
          [1, "v1"],
          [2, "v2"],
          [3, "v3"],
        ])
      }),
    ),
  )

  it.effect("versions() reads a version under both keys once, from the current key", () =>
    withPutDoc((table) =>
      Effect.gen(function* () {
        const db = yield* clientOf(On)
        // The same snapshot under the current key too (a copy from a backup).
        const copy = table.items.get(`${pk136}|${snapshotSk(1)}`)!
        table.items.set(`${pkNow}|${snapshotSk(1)}`, { ...copy, pk: { S: pkNow } })
        table.take()
        const versions = yield* db.entities.Docs.versions(key).collect()
        expect(versions.map((d) => [versionOf(d), d.title])).toEqual([[1, "v1"]])
        // A keys-only look under the 1.36 key, the current key's versions, then both passes.
        expect(
          table
            .take()
            .filter((r) => r.command === "Query")
            .map((r) => [
              (r.input.ExpressionAttributeValues as Record<string, AttributeValue>)[":pk"]?.S,
              r.input.Limit ?? null,
            ]),
        ).toEqual([
          [pk136, 1],
          [pkNow, null],
          [pk136, null],
          [pkNow, null],
        ])
      }),
    ),
  )

  it.effect("a version whose current key holds another snapshot: the item moves without it", () =>
    withPutDoc((table) =>
      Effect.gen(function* () {
        const db = yield* clientOf(On)
        // Another state's version 1 snapshot under the current key.
        const copy = table.items.get(`${pk136}|${snapshotSk(1)}`)!
        table.items.set(`${pkNow}|${snapshotSk(1)}`, {
          ...copy,
          pk: { S: pkNow },
          __edd_i__: { S: "another-incarnation" },
        })
        table.take()
        // The update's own snapshot of version 1 meets that history and is refused…
        const error = yield* db.entities.Docs.update(key)
          .set({ title: "v2" })
          .asEffect()
          .pipe(Effect.flip)
        expect(error._tag).toBe("ValidationError")
        // …after the item moved: the 1.36 snapshot stays, for `rekey` to report.
        expect(rowsUnder(table, pk136)).toEqual([snapshotSk(1)])
        expect(table.items.has(`${pkNow}|${sk}`)).toBe(true)
      }),
    ),
  )
})
