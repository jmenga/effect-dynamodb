/**
 * #171 rows still under their 1.36 keys — connected tests against DynamoDB
 * Local.
 *
 * 1.37 composes some key text differently from 1.36: numbers (`-7` was
 * `00000000000000-7`), sort key values holding a character up to `%` (`san
 * jose` was not escaped) and time-series event keys. Each test writes its rows
 * as 1.36 did — the row is written by the entity, then rewritten under the key
 * text `KeyText136` composes (the composer the golden vectors from the
 * published 1.36.0 pin) with the raw client, its unique sentinels with it —
 * and then runs a 1.37 operation over them, asserting the result, where every
 * row ends up (never under both keys), the GSI keys and the sentinels.
 *
 * `Meters` carries the six canonical GSI shapes (CLAUDE.md), so a move
 * recomposes each from the stored item under its index policy.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyText136 from "@effect-dynamodb/schema/internal/KeyText136.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Config, Effect, Layer, Schema, Stream } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import * as Batch from "../src/Batch.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Expression from "../src/Expression.js"
import { fromAttributeMap, toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"

// ---------------------------------------------------------------------------
// Skip when DynamoDB Local isn't reachable
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "legacy-keys", version: 1 })
const OffSchema = DynamoSchema.make({ name: "legacy-keys", version: 1, legacyKeys: false })
const tableName = `legacy-keys-${Date.now()}`

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

const Meters = Entity.make({
  model: Meter,
  entityType: "Meter",
  primaryKey: {
    pk: { field: "pk", composite: ["site"] },
    sk: { field: "sk", composite: ["meterId"] },
  },
  indexes: {
    // 1. Multi-writer: `zone` is an enrichment's, `reading` telemetry's.
    byZone: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["zone"] },
      sk: { field: "gsi1sk", composite: ["reading"] },
    },
    // 2. PK-composites-only.
    byChannel: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["site"] },
      sk: { field: "gsi2sk", composite: ["meterId"] },
    },
    // 3. Hierarchical.
    byPlace: {
      name: "gsi3",
      pk: { field: "gsi3pk", composite: ["region"] },
      sk: { field: "gsi3sk", composite: ["country", "city", "meterId"] },
    },
    // 4. Hole pattern (`shelf` missing, `bin` present), preserved and sparse.
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
    // 5. All composites mutable.
    byStatus: {
      name: "gsi6",
      pk: { field: "gsi6pk", composite: ["status"] },
      sk: { field: "gsi6sk", composite: ["label"] },
    },
    // 6. Empty-composite half.
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

class Note extends Schema.Class<Note>("Note")({
  owner: Schema.String,
  title: Schema.String,
  body: Schema.String,
}) {}

const notePrimaryKey = {
  pk: { field: "pk", composite: ["owner"] },
  sk: { field: "sk", composite: ["title"] },
} as const
const Notes = Entity.make({ model: Note, entityType: "Note", primaryKey: notePrimaryKey })
const OffNotes = Entity.make({ model: Note, entityType: "Note", primaryKey: notePrimaryKey })

class Doc extends Schema.Class<Doc>("Doc")({
  docId: Schema.Number,
  title: Schema.String,
}) {}

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

class Gauge extends Schema.Class<Gauge>("Gauge")({
  gaugeId: Schema.Number,
  at: Schema.Number,
  level: Schema.Number,
  label: Schema.optional(Schema.String),
}) {}

const Gauges = Entity.make({
  model: Gauge,
  entityType: "Gauge",
  primaryKey: {
    pk: { field: "pk", composite: ["gaugeId"] },
    sk: { field: "sk", composite: [] },
  },
  timeSeries: {
    orderBy: "at",
    appendInput: Schema.Struct({ gaugeId: Schema.Number, at: Schema.Number, level: Schema.Number }),
  },
})

/** Notes with timestamps only: an update writes no version to race on. */
const Stamped = Entity.make({
  model: Note,
  entityType: "Stamped",
  primaryKey: notePrimaryKey,
  timestamps: true,
})

/** Notes with an index over the title: a sort key composite another value's 1.36 text can spell. */
const Memos = Entity.make({
  model: Note,
  entityType: "Memo",
  primaryKey: notePrimaryKey,
  indexes: {
    byTitle: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["owner"] },
      sk: { field: "gsi1sk", composite: ["title"] },
    },
  },
})

/** Notes retaining their versions, soft-deleted: an item's history prefix carries its title. */
const Pages = Entity.make({
  model: Note,
  entityType: "Page",
  primaryKey: notePrimaryKey,
  versioned: { retain: true },
  softDelete: true,
})

class Tick extends Schema.Class<Tick>("Tick")({
  tickId: Schema.Number,
  at: Schema.NumberFromString,
  level: Schema.Number,
}) {}

/** A string-encoded numeric orderBy: 1.36 keyed its events by their text. */
const Ticks = Entity.make({
  model: Tick,
  entityType: "Tick",
  primaryKey: {
    pk: { field: "pk", composite: ["tickId"] },
    sk: { field: "sk", composite: [] },
  },
  timeSeries: {
    orderBy: "at",
    appendInput: Schema.Struct({
      tickId: Schema.Number,
      at: Schema.NumberFromString,
      level: Schema.Number,
    }),
  },
})

class Reading extends Schema.Class<Reading>("Reading")({
  deviceId: Schema.String,
  seq: Schema.Number,
  label: Schema.String,
  serial: Schema.Number,
}) {}

/**
 * Retained and soft-deletable, keyed by a number in its sort key: an item's
 * history rows carry its segment, whose text changed for a negative `seq`.
 */
const Readings = Entity.make({
  model: Reading,
  entityType: "Reading",
  primaryKey: {
    pk: { field: "pk", composite: ["deviceId"] },
    sk: { field: "sk", composite: ["seq"] },
  },
  indexes: {
    byLabel: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["deviceId"] },
      sk: { field: "gsi1sk", composite: ["label"] },
    },
  },
  unique: { serial: ["serial"] },
  timestamps: true,
  versioned: { retain: true },
  softDelete: true,
})

const MainTable = Table.make({
  schema: AppSchema,
  entities: { Meters, Notes, Docs, Gauges, Stamped, Memos, Ticks, Readings, Pages },
})
const OffTable = Table.make({ schema: OffSchema, entities: { Notes: OffNotes } })

const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})
const TestLayer = Layer.mergeAll(
  ClientLayer,
  MainTable.layer({ name: tableName }),
  OffTable.layer({ name: tableName }),
)
const provide = Effect.provide(TestLayer)

const makeDb = DynamoClient.make({
  entities: { Meters, Notes, Docs, Gauges, Stamped, Memos, Ticks, Readings, Pages },
  tables: { MainTable },
})
const makeOffDb = DynamoClient.make({ entities: { Notes: OffNotes }, tables: { OffTable } })

// ---------------------------------------------------------------------------
// Rows as 1.36 wrote them
// ---------------------------------------------------------------------------

type Keys = Record<string, string>
type Indexed = { readonly entityType: string; readonly indexes: Record<string, any> }

const getRaw = (key: Keys) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const { Item } = yield* client.getItem({
      TableName: tableName,
      Key: toAttributeMap(key),
      ConsistentRead: true,
    })
    return Item
  })

/** The current and 1.36 primary keys of `record`. */
const keysOf = (entity: Indexed, record: Record<string, unknown>) => ({
  current: KeyComposer.composeIndexKeys(
    AppSchema,
    entity.entityType,
    1,
    entity.indexes.primary,
    record,
  ) as Keys,
  old: KeyText136.composeIndexKeys(AppSchema, entity.entityType, 1, entity.indexes.primary, record),
})

/** A unique sentinel's current and 1.36 keys. */
const sentinelKeys = (entityType: string, name: string, value: unknown) => {
  const current = DynamoSchema.composeUniqueKey(AppSchema, entityType, name, [
    KeyComposer.serializeValue(value),
  ])
  const old = KeyText136.composeUniqueKey(AppSchema, entityType, name, [value])
  return { current: { pk: current.pk, sk: current.sk }, old: { pk: old.pk, sk: old.sk } }
}

/**
 * Rewrite the item the entity wrote at `record`'s key as 1.36 wrote it: under
 * its 1.36 primary key and 1.36 GSI key text (plus `extra`), with its unique
 * sentinels under their 1.36 keys pointing at it. The 1.37 rows are removed.
 */
const demote = (
  entity: Indexed & { readonly unique?: unknown },
  record: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const { current, old } = keysOf(entity, record)
    expect(old).not.toEqual(current)
    const stored = yield* getRaw(current)
    expect(stored).toBeDefined()
    const item: Record<string, AttributeValue> = { ...stored! }
    for (const [name, index] of Object.entries(entity.indexes)) {
      if (name === "primary") continue
      delete item[index.pk.field]
      delete item[index.sk.field]
    }
    const keys = KeyText136.composeAllKeys(AppSchema, entity.entityType, 1, entity.indexes, record)
    yield* client.putItem({
      TableName: tableName,
      Item: { ...item, ...toAttributeMap({ ...keys, ...extra }) },
    })
    yield* client.deleteItem({ TableName: tableName, Key: toAttributeMap(current) })
    for (const [name, fields] of Object.entries(
      (entity.unique ?? {}) as Record<string, ReadonlyArray<string>>,
    )) {
      const sentinel = sentinelKeys(entity.entityType, name, record[fields[0]!])
      const held = yield* getRaw(sentinel.current)
      expect(held).toBeDefined()
      yield* client.deleteItem({ TableName: tableName, Key: toAttributeMap(sentinel.current) })
      yield* client.putItem({
        TableName: tableName,
        Item: {
          ...held!,
          ...toAttributeMap({ ...sentinel.old, _entity_pk: old.pk, _entity_sk: old.sk }),
        },
      })
    }
    return { current, old }
  })

/** Rewrite every row in `record`'s partition under the 1.36 partition key. */
const demotePartition = (entity: Indexed, record: Record<string, unknown>) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const { current, old } = keysOf(entity, record)
    expect(old.pk).not.toBe(current.pk)
    const { Items = [] } = yield* client.query({
      TableName: tableName,
      KeyConditionExpression: "#pk = :pk",
      ExpressionAttributeNames: { "#pk": "pk" },
      ExpressionAttributeValues: { ":pk": { S: current.pk! } },
      ConsistentRead: true,
    })
    for (const row of Items) {
      yield* client.putItem({ TableName: tableName, Item: { ...row, pk: { S: old.pk! } } })
      yield* client.deleteItem({ TableName: tableName, Key: { pk: row.pk!, sk: row.sk! } })
    }
    return { current, old, rows: Items.length }
  })

const partition = (pk: string) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const { Items = [] } = yield* client.query({
      TableName: tableName,
      KeyConditionExpression: "#pk = :pk",
      ExpressionAttributeNames: { "#pk": "pk" },
      ExpressionAttributeValues: { ":pk": { S: pk } },
      ConsistentRead: true,
    })
    return Items.map((row) => fromAttributeMap(row))
  })

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let serials = 0
/** A meter whose primary, GSI and sentinel key text all changed in 1.37. */
const meterOf = (site: string, overrides: Partial<Meter> = {}) => ({
  site,
  meterId: -7,
  serial: -1000 - ++serials,
  reading: -2.5,
  region: "emea",
  country: "uk",
  city: "san jose",
  bin: -1,
  status: "active",
  label: "a b",
  deviceBinding: -9,
  ...overrides,
})
const meterKey = (site: string) => ({ site, meterId: -7 })

/** Write a meter as 1.36 did; a stale hole-pattern GSI half stays from an earlier write. */
const seedMeter = (site: string, overrides: Partial<Meter> = {}) =>
  Effect.gen(function* () {
    const db = yield* makeDb
    const record = meterOf(site, overrides)
    yield* db.entities.Meters.put(record).asEffect()
    const keys = yield* demote(Meters, record, {
      // The multi-writer index's telemetry half, without the enrichment's.
      gsi1sk: KeyText136.composeSk(AppSchema, "Meter", 1, Meters.indexes.byZone, record),
      gsi4pk: "stale-4pk",
      gsi4sk: "stale-4sk",
      gsi5pk: "stale-5pk",
      gsi5sk: "stale-5sk",
    })
    return { record, ...keys }
  })

/** The meter is at its current key only, with every GSI shape recomposed. */
const expectMoved = (record: Record<string, unknown>, current: Keys, old: Keys) =>
  Effect.gen(function* () {
    expect(yield* getRaw(old)).toBeUndefined()
    const item = fromAttributeMap((yield* getRaw(current))!)
    const compose = (name: keyof typeof Meters.indexes) =>
      KeyComposer.composeIndexKeys(AppSchema, "Meter", 1, Meters.indexes[name], record)
    const composePk = (name: keyof typeof Meters.indexes) =>
      KeyComposer.composePk(AppSchema, "Meter", Meters.indexes[name], record)
    // 1. Multi-writer: the telemetry half recomposed, the enrichment's left absent.
    expect(item.gsi1pk).toBeUndefined()
    expect(item.gsi1sk).toBe(
      KeyComposer.composeSk(AppSchema, "Meter", 1, Meters.indexes.byZone, record),
    )
    expect(item.gsi1sk).not.toBe(
      KeyText136.composeSk(AppSchema, "Meter", 1, Meters.indexes.byZone, record),
    )
    // 2, 3, 5, 6: recomposed in their 1.37 text.
    for (const name of ["byChannel", "byPlace", "byStatus", "byBinding"] as const) {
      const keys = compose(name)
      for (const [field, value] of Object.entries(keys)) expect(item[field], name).toBe(value)
      expect(
        KeyText136.composeIndexKeys(AppSchema, "Meter", 1, Meters.indexes[name], record),
        name,
      ).not.toEqual(keys)
    }
    // 4. Hole: the partition half recomposed; the sort half kept under
    // 'preserve', dropped under 'sparse'.
    expect(item.gsi4pk).toBe(composePk("byShelf"))
    expect(item.gsi4sk).toBe("stale-4sk")
    expect(item.gsi5pk).toBe(composePk("byShelfSparse"))
    expect(item.gsi5sk).toBeUndefined()
    return item
  })

/** Who holds the sentinel of `serial`: its current and 1.36 keys' back-pointers. */
const sentinelOwners = (serial: number) =>
  Effect.gen(function* () {
    const keys = sentinelKeys("Meter", "serial", serial)
    const owner = (item: Record<string, AttributeValue> | undefined) =>
      item === undefined ? undefined : `${item._entity_pk?.S}|${item._entity_sk?.S}`
    return {
      current: owner(yield* getRaw(keys.current)),
      old: owner(yield* getRaw(keys.old)),
    }
  })

const ownerOf = (key: Keys) => `${key.pk}|${key.sk}`

/** A snapshot's version: `versions()` returns the model, which doesn't declare it. */
const versionOf = (item: unknown) => (item as { readonly version: number }).version

/**
 * Rewrite a reading's history rows — its version snapshots and tombstones —
 * under the item segment of its 1.36 sort key, as 1.36 keyed them.
 */
const demoteHistory = (record: Record<string, unknown>) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const { current, old } = keysOf(Readings, record)
    const primary = Readings.indexes.primary
    const segment = (liveSk: string) => ({
      item: KeyComposer.composeHistoryItemSegment(AppSchema, "Reading", 1, primary, liveSk)!,
    })
    const versions = DynamoSchema.composeVersionKeyPrefix(
      AppSchema,
      "Reading",
      segment(current.sk!),
    )
    const tombstones = DynamoSchema.composeDeletedKeyPrefix(
      AppSchema,
      "Reading",
      segment(current.sk!),
    )
    const history = (yield* partition(current.pk!)).filter((row) => {
      const sk = String(row.sk)
      return sk.startsWith(versions) || sk.startsWith(tombstones)
    })
    expect(history.length).toBeGreaterThan(0)
    for (const row of history) {
      const sk = String(row.sk)
      const tail = sk.slice(sk.lastIndexOf("#") + 1)
      const sk136 = sk.startsWith(versions)
        ? DynamoSchema.composeVersionKey(AppSchema, "Reading", Number(tail), segment(old.sk!))
        : DynamoSchema.composeDeletedKey(AppSchema, "Reading", tail, segment(old.sk!))
      expect(sk136).not.toBe(sk)
      yield* client.deleteItem({ TableName: tableName, Key: toAttributeMap({ pk: row.pk, sk }) })
      yield* client.putItem({
        TableName: tableName,
        Item: toAttributeMap({ ...row, pk: old.pk, sk: sk136 }),
      })
    }
    return {
      current,
      old,
      versions136: DynamoSchema.composeVersionKeyPrefix(AppSchema, "Reading", segment(old.sk!)),
    }
  })

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeConnected("#171 rows still under their 1.36 keys — connected", () => {
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
  }, 60_000)

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

  describe("single-item reads", () => {
    it.effect("get reads an item under its 1.36 key and leaves it there", () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        const { record, current, old } = yield* seedMeter("get")
        const got = yield* db.entities.Meters.get(meterKey("get")).asEffect()
        expect(got).toMatchObject({ ...record, city: "san jose", label: "a b" })
        expect(yield* getRaw(current)).toBeUndefined()
        expect(yield* getRaw(old)).toBeDefined()
        // Nothing under either key: ItemNotFound, as always.
        const missing = yield* db.entities.Meters.get({ site: "get", meterId: -8 })
          .asEffect()
          .pipe(Effect.flip)
        expect(missing._tag).toBe("ItemNotFound")
      }).pipe(provide),
    )

    it.effect("batchGet and transactGet read the misses again under their 1.36 keys", () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* seedMeter("bget")
        yield* db.entities.Notes.put({ owner: "bget", title: "plain", body: "now" }).asEffect()
        const [meter, note, none] = yield* Batch.get([
          Meters.get(meterKey("bget")),
          Notes.get({ owner: "bget", title: "plain" }),
          Meters.get({ site: "bget", meterId: -8 }),
        ])
        expect(meter?.serial).toBeLessThan(-1000)
        expect(note?.body).toBe("now")
        expect(none).toBeUndefined()
        const [tMeter, tNote, tNone] = yield* Transaction.transactGet([
          Meters.get(meterKey("bget")),
          Notes.get({ owner: "bget", title: "plain" }),
          Meters.get({ site: "bget", meterId: -8 }),
        ])
        expect(tMeter?.meterId).toBe(-7)
        expect(tNote?.body).toBe("now")
        expect(tNone).toBeUndefined()
      }).pipe(provide),
    )

    it.effect("legacyKeys: false reads the current key only", () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        const off = yield* makeOffDb
        const note = { owner: "off", title: "new york", body: "1.36" }
        yield* db.entities.Notes.put(note).asEffect()
        yield* demote(Notes, note)
        expect((yield* db.entities.Notes.get(note).asEffect()).body).toBe("1.36")
        const err = yield* off.entities.Notes.get(note).asEffect().pipe(Effect.flip)
        expect(err._tag).toBe("ItemNotFound")
      }).pipe(provide),
    )
  })

  describe("writes move the item", () => {
    it.effect("update moves the item — every GSI shape and its sentinel — then applies", () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        const { record, current, old } = yield* seedMeter("update")
        const updated = yield* db.entities.Meters.update(meterKey("update"))
          .set({ note: "moved" })
          .asEffect()
        expect(updated.note).toBe("moved")
        const item = yield* expectMoved(record, current, old)
        expect(item.version).toBe(2)
        expect(item.note).toBe("moved")
        expect(yield* sentinelOwners(record.serial)).toEqual({
          current: ownerOf(current),
          old: undefined,
        })
        // The moved item is in its GSIs under their 1.37 text.
        const byChannel = yield* db.entities.Meters.byChannel({ site: "update" }).collect()
        expect(byChannel.map((m) => m.meterId)).toEqual([-7])
        const byBinding = yield* db.entities.Meters.byBinding({ deviceBinding: -9 })
          .filter({ site: "update" })
          .collect()
        expect(byBinding).toHaveLength(1)
        // The unique value is still held: another item can't take it.
        const taken = yield* db.entities.Meters.put(meterOf("update-2", { serial: record.serial }))
          .asEffect()
          .pipe(Effect.flip)
        expect(taken._tag).toBe("UniqueConstraintViolation")
      }).pipe(provide),
    )

    it.effect("a unique value held under its 1.36 sentinel key is taken", () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        const { record, old } = yield* seedMeter("held")
        const other = { ...meterOf("held-2"), serial: record.serial }
        const put = yield* db.entities.Meters.put(other).asEffect().pipe(Effect.flip)
        expect(put._tag).toBe("UniqueConstraintViolation")
        const created = yield* db.entities.Meters.create(other).asEffect().pipe(Effect.flip)
        expect(created._tag).toBe("UniqueConstraintViolation")
        yield* db.entities.Meters.put({ ...other, serial: -2 }).asEffect()
        const updated = yield* db.entities.Meters.update({ site: "held-2", meterId: -7 })
          .set({ serial: record.serial })
          .asEffect()
          .pipe(Effect.flip)
        expect(updated._tag).toBe("UniqueConstraintViolation")
        // The holder was not touched.
        expect(yield* getRaw(old)).toBeDefined()
        expect((yield* sentinelOwners(record.serial)).old).toBe(ownerOf(old))
      }).pipe(provide),
    )

    it.effect("update with a new unique value moves the sentinel and rotates it", () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        const { record, current, old } = yield* seedMeter("rotate")
        yield* db.entities.Meters.update(meterKey("rotate")).set({ serial: -1 }).asEffect()
        yield* expectMoved({ ...record, serial: -1 }, current, old)
        expect(yield* sentinelOwners(record.serial)).toEqual({ current: undefined, old: undefined })
        expect((yield* sentinelOwners(-1)).current).toBe(ownerOf(current))
      }).pipe(provide),
    )

    it.effect("patch moves the item, then applies; a missing item still fails", () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        const { record, current, old } = yield* seedMeter("patch")
        const patched = yield* db.entities.Meters.patch(meterKey("patch"))
          .set({ note: "patched" })
          .asEffect()
        expect(patched.note).toBe("patched")
        yield* expectMoved(record, current, old)
        const err = yield* db.entities.Meters.patch({ site: "patch", meterId: -8 })
          .set({ note: "x" })
          .asEffect()
          .pipe(Effect.flip)
        expect(err._tag).toBe("ConditionalCheckFailed")
      }).pipe(provide),
    )

    it.effect("an expectedVersion and a condition are judged on the moved item", () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* seedMeter("cas")
        const stale = yield* db.entities.Meters.update(meterKey("cas"))
          .set({ note: "x" })
          .expectedVersion(5)
          .asEffect()
          .pipe(Effect.flip)
        expect(stale._tag).toBe("OptimisticLockError")
        const refused = yield* db.entities.Meters.update(meterKey("cas"))
          .set({ note: "x" })
          .condition({ status: "retired" })
          .asEffect()
          .pipe(Effect.flip)
        expect(refused._tag).toBe("ConditionalCheckFailed")
        const ok = yield* db.entities.Meters.update(meterKey("cas"))
          .set({ note: "y" })
          .expectedVersion(1)
          .condition({ status: "active" })
          .asEffect()
        expect(ok.note).toBe("y")
      }).pipe(provide),
    )

    it.effect("put replaces the item at its current key, sentinel and all", () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        const { record, current, old } = yield* seedMeter("put")
        const put = yield* db.entities.Meters.put({ ...record, note: "replaced" }).asEffect()
        expect(put.note).toBe("replaced")
        expect(yield* getRaw(old)).toBeUndefined()
        const item = fromAttributeMap((yield* getRaw(current))!)
        expect(item.note).toBe("replaced")
        expect(yield* sentinelOwners(record.serial)).toEqual({
          current: ownerOf(current),
          old: undefined,
        })
      }).pipe(provide),
    )

    it.effect("put of an item without unique or versioning: one transaction", () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        const note = { owner: "put", title: "san jose", body: "1.36" }
        yield* db.entities.Notes.put(note).asEffect()
        const { current, old } = yield* demote(Notes, note)
        yield* db.entities.Notes.put({ ...note, body: "1.37" }).asEffect()
        expect(yield* getRaw(old)).toBeUndefined()
        expect(fromAttributeMap((yield* getRaw(current))!).body).toBe("1.37")
        // A condition is judged on the item wherever it is.
        yield* demote(Notes, { ...note, body: "1.37" })
        const refused = yield* db.entities.Notes.put({ ...note, body: "x" })
          .condition({ body: "other" })
          .asEffect()
          .pipe(Effect.flip)
        expect(refused._tag).toBe("ConditionalCheckFailed")
        yield* db.entities.Notes.put({ ...note, body: "y" })
          .condition({ body: "1.37" })
          .asEffect()
        expect(yield* getRaw(old)).toBeUndefined()
        expect(fromAttributeMap((yield* getRaw(current))!).body).toBe("y")
      }).pipe(provide),
    )

    it.effect("create fails when the item is under its 1.36 key", () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        const { record, old } = yield* seedMeter("create")
        const err = yield* db.entities.Meters.create(record).asEffect().pipe(Effect.flip)
        expect(err._tag).toBe("ConditionalCheckFailed")
        expect(yield* getRaw(old)).toBeDefined()
        const note = { owner: "create", title: "a b", body: "1.36" }
        yield* db.entities.Notes.put(note).asEffect()
        const keys = yield* demote(Notes, note)
        const noteErr = yield* db.entities.Notes.create(note).asEffect().pipe(Effect.flip)
        expect(noteErr._tag).toBe("ConditionalCheckFailed")
        expect(yield* getRaw(keys.current)).toBeUndefined()
        expect(yield* getRaw(keys.old)).toBeDefined()
      }).pipe(provide),
    )

    it.effect("upsert moves the item, then writes it", () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        const { record, current, old } = yield* seedMeter("upsert")
        const up = yield* db.entities.Meters.upsert({ ...record, note: "upserted" }).asEffect()
        expect(up.note).toBe("upserted")
        expect(yield* getRaw(old)).toBeUndefined()
        expect(fromAttributeMap((yield* getRaw(current))!).note).toBe("upserted")
        expect((yield* sentinelOwners(record.serial)).old).toBeUndefined()
      }).pipe(provide),
    )

    it.effect("delete removes the item and its sentinel wherever they are", () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        const { record, current, old } = yield* seedMeter("delete")
        yield* db.entities.Meters.delete(meterKey("delete")).asEffect()
        expect(yield* getRaw(old)).toBeUndefined()
        expect(yield* getRaw(current)).toBeUndefined()
        expect(yield* sentinelOwners(record.serial)).toEqual({ current: undefined, old: undefined })
        // Released: the value is free again.
        yield* db.entities.Meters.put(meterOf("delete-2", { serial: record.serial })).asEffect()
      }).pipe(provide),
    )

    it.effect("deleteIfExists and a conditioned delete judge the 1.36 item", () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        const note = { owner: "del", title: "new york", body: "1.36" }
        yield* db.entities.Notes.put(note).asEffect()
        const { old } = yield* demote(Notes, note)
        const refused = yield* db.entities.Notes.delete(note)
          .condition({ body: "other" })
          .asEffect()
          .pipe(Effect.flip)
        expect(refused._tag).toBe("ConditionalCheckFailed")
        expect(yield* getRaw(old)).toBeDefined()
        yield* db.entities.Notes.deleteIfExists(note).asEffect()
        expect(yield* getRaw(old)).toBeUndefined()
        const gone = yield* db.entities.Notes.deleteIfExists(note).asEffect().pipe(Effect.flip)
        expect(gone._tag).toBe("ConditionalCheckFailed")
        // A plain delete of a 1.36 item.
        yield* db.entities.Notes.put(note).asEffect()
        const again = yield* demote(Notes, note)
        yield* db.entities.Notes.delete(note).asEffect()
        expect(yield* getRaw(again.old)).toBeUndefined()
        expect(yield* getRaw(again.current)).toBeUndefined()
      }).pipe(provide),
    )

    it.effect("two concurrent updates of an unmoved item both apply; it moves once", () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        const { record, current, old } = yield* seedMeter("race")
        yield* Effect.all(
          [
            db.entities.Meters.update(meterKey("race")).set({ note: "a" }).asEffect(),
            db.entities.Meters.update(meterKey("race")).set({ status: "busy" }).asEffect(),
          ],
          { concurrency: 2 },
        )
        const item = yield* expectMoved({ ...record, status: "busy" }, current, old)
        expect(item.version).toBe(3)
        expect(item.note).toBe("a")
        expect(yield* sentinelOwners(record.serial)).toEqual({
          current: ownerOf(current),
          old: undefined,
        })
      }).pipe(provide),
    )
  })

  describe("batch writes and transactions", () => {
    it.effect("Batch.write deletes the 1.36 key of a put (once it is written) or a delete", () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        const a = { owner: "bw", title: "a b", body: "1.36" }
        const b = { owner: "bw", title: "c d", body: "1.36" }
        yield* db.entities.Notes.put(a).asEffect()
        yield* db.entities.Notes.put(b).asEffect()
        const ka = yield* demote(Notes, a)
        const kb = yield* demote(Notes, b)
        yield* Batch.write([Notes.put({ ...a, body: "1.37" }), Notes.delete(b)])
        expect(yield* getRaw(ka.old)).toBeUndefined()
        expect(fromAttributeMap((yield* getRaw(ka.current))!).body).toBe("1.37")
        expect(yield* getRaw(kb.old)).toBeUndefined()
        expect(yield* getRaw(kb.current)).toBeUndefined()
      }).pipe(provide),
    )

    it.effect("transactWrite: a put or a delete deletes the 1.36 key; a create checks it", () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        const a = { owner: "tw", title: "a b", body: "1.36" }
        const b = { owner: "tw", title: "c d", body: "1.36" }
        yield* db.entities.Notes.put(a).asEffect()
        yield* db.entities.Notes.put(b).asEffect()
        const ka = yield* demote(Notes, a)
        const kb = yield* demote(Notes, b)
        const created = yield* Transaction.transactWrite([Notes.create(a)]).pipe(Effect.flip)
        expect(created._tag).toBe("TransactionCancelled")
        expect(yield* getRaw(ka.old)).toBeDefined()
        yield* Transaction.transactWrite([Notes.put({ ...a, body: "1.37" }), Notes.delete(b)])
        expect(yield* getRaw(ka.old)).toBeUndefined()
        expect(fromAttributeMap((yield* getRaw(ka.current))!).body).toBe("1.37")
        expect(yield* getRaw(kb.old)).toBeUndefined()
        expect(yield* getRaw(kb.current)).toBeUndefined()
      }).pipe(provide),
    )

    it.effect(
      "transactWrite: an update, a conditioned write or a check of an unmoved item fails ItemNotMoved",
      () =>
        Effect.gen(function* () {
          const db = yield* makeDb
          const note = { owner: "tnm", title: "a b", body: "1.36" }
          yield* db.entities.Notes.put(note).asEffect()
          const keys = yield* demote(Notes, note)
          const bystander = { owner: "tnm", title: "plain", body: "never" }
          const attempts = [
            Notes.update(note).pipe(Entity.set({ body: "x" })),
            Notes.patch(note).pipe(Entity.set({ body: "x" })),
            Notes.put({ ...note, body: "x" }).pipe(Notes.condition({ eq: { body: "1.36" } })),
            Notes.delete(note).pipe(Notes.condition({ eq: { body: "1.36" } })),
            Transaction.check(Notes.get(note), Expression.condition({ eq: { body: "1.36" } })),
          ] as const
          for (const attempt of attempts) {
            const err = yield* Transaction.transactWrite([attempt, Notes.put(bystander)]).pipe(
              Effect.flip,
            )
            expect(err._tag).toBe("ItemNotMoved")
            expect(err.message).toContain("EDD-9097")
          }
          expect(yield* getRaw(keys.old)).toBeDefined()
          expect(yield* getRaw(keys.current)).toBeUndefined()
          expect(
            yield* db.entities.Notes.get({ owner: "tnm", title: "plain" })
              .asEffect()
              .pipe(Effect.flip),
          ).toMatchObject({ _tag: "ItemNotFound" })
          // Written once through the entity, it has moved: the transaction runs.
          yield* db.entities.Notes.put(note).asEffect()
          yield* Transaction.transactWrite([Notes.update(note).pipe(Entity.set({ body: "x" }))])
          expect(fromAttributeMap((yield* getRaw(keys.current))!).body).toBe("x")
          // An entity with a unique constraint plans its update from a read.
          const meter = yield* seedMeter("tnm")
          const unique = yield* Transaction.transactWrite([
            Meters.update(meterKey("tnm")).pipe(Entity.set({ note: "x" })),
          ]).pipe(Effect.flip)
          expect(unique._tag).toBe("ItemNotMoved")
          expect(yield* getRaw(meter.old)).toBeDefined()
        }).pipe(provide),
    )
  })

  describe("history, soft delete and restore", () => {
    const doc = (docId: number, title: string) => ({ docId, title })

    it.effect("getVersion reads a snapshot under its 1.36 partition", () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.entities.Docs.put(doc(-1, "v1")).asEffect()
        yield* db.entities.Docs.update({ docId: -1 }).set({ title: "v2" }).asEffect()
        const { rows } = yield* demotePartition(Docs, { docId: -1 })
        expect(rows).toBe(2)
        expect((yield* db.entities.Docs.getVersion({ docId: -1 }, 1)).title).toBe("v1")
        expect((yield* db.entities.Docs.get({ docId: -1 }).asEffect()).title).toBe("v2")
      }).pipe(provide),
    )

    it.effect("a retained update moves the item first and continues its versions", () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.entities.Docs.put(doc(-2, "v1")).asEffect()
        yield* db.entities.Docs.update({ docId: -2 }).set({ title: "v2" }).asEffect()
        const { current, old } = yield* demotePartition(Docs, { docId: -2 })
        const v3 = yield* db.entities.Docs.update({ docId: -2 }).set({ title: "v3" }).asEffect()
        expect(v3.title).toBe("v3")
        expect(yield* getRaw(old)).toBeUndefined()
        const live = fromAttributeMap((yield* getRaw(current))!)
        expect(live.version).toBe(3)
        expect((yield* db.entities.Docs.getVersion({ docId: -2 }, 2)).title).toBe("v2")
        expect((yield* db.entities.Docs.getVersion({ docId: -2 }, 1)).title).toBe("v1")
      }).pipe(provide),
    )

    it.effect("soft delete moves the item first; its tombstone is under the current key", () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.entities.Docs.put(doc(-3, "v1")).asEffect()
        const { current, old } = yield* demotePartition(Docs, { docId: -3 })
        yield* db.entities.Docs.delete({ docId: -3 }).asEffect()
        expect(yield* getRaw(old)).toBeUndefined()
        expect(yield* getRaw(current)).toBeUndefined()
        // The version 1 snapshot put wrote moved with the item — the soft delete
        // snapshots version 1 again, under the current key — so it is held once.
        expect(yield* partition(old.pk!)).toEqual([])
        const versions = yield* db.entities.Docs.versions({ docId: -3 }).collect()
        expect(versions.map((d) => [versionOf(d), d.title])).toEqual([[1, "v1"]])
        expect((yield* db.entities.Docs.deleted.get({ docId: -3 })).title).toBe("v1")
        const restored = yield* db.entities.Docs.restore({ docId: -3 })
        expect(restored.title).toBe("v1")
        expect(yield* getRaw(current)).toBeDefined()
      }).pipe(provide),
    )

    it.effect(
      "deleted.get and restore find a 1.36 tombstone; restore lands at the current key",
      () =>
        Effect.gen(function* () {
          const db = yield* makeDb
          yield* db.entities.Docs.put(doc(-4, "v1")).asEffect()
          yield* db.entities.Docs.delete({ docId: -4 }).asEffect()
          const { current, old } = yield* demotePartition(Docs, { docId: -4 })
          expect((yield* db.entities.Docs.deleted.get({ docId: -4 })).title).toBe("v1")
          const restored = yield* db.entities.Docs.restore({ docId: -4 })
          expect(restored.title).toBe("v1")
          expect(yield* getRaw(old)).toBeUndefined()
          expect(fromAttributeMap((yield* getRaw(current))!).title).toBe("v1")
          expect(
            (yield* partition(old.pk!)).filter((r) => String(r.sk).includes("deleted")),
          ).toEqual([])
          // Restored: no tombstone left under either key.
          const again = yield* db.entities.Docs.restore({ docId: -4 }).pipe(Effect.flip)
          expect(again._tag).toBe("ItemNotFound")
        }).pipe(provide),
    )

    it.effect("restore refuses a tombstone while the item lives under its 1.36 key", () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.entities.Docs.put(doc(-7, "v1")).asEffect()
        yield* db.entities.Docs.delete({ docId: -7 }).asEffect()
        // Written again, as 1.36 would have: live under the 1.36 key.
        yield* db.entities.Docs.put(doc(-7, "v2")).asEffect()
        const { old } = yield* demote(Docs, { docId: -7 })
        const err = yield* db.entities.Docs.restore({ docId: -7 }).pipe(Effect.flip)
        expect(err._tag).toBe("ItemNotDeleted")
        expect(fromAttributeMap((yield* getRaw(old))!).title).toBe("v2")
      }).pipe(provide),
    )

    it.effect("purge removes the rows under both partitions", () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.entities.Docs.put(doc(-5, "v1")).asEffect()
        yield* db.entities.Docs.update({ docId: -5 }).set({ title: "v2" }).asEffect()
        const { current, old } = yield* demotePartition(Docs, { docId: -5 })
        // One more version under the current key: the item moves first.
        yield* db.entities.Docs.update({ docId: -5 }).set({ title: "v3" }).asEffect()
        expect((yield* partition(old.pk!)).length).toBeGreaterThan(0)
        expect((yield* partition(current.pk!)).length).toBeGreaterThan(0)
        yield* db.entities.Docs.purge({ docId: -5 })
        expect(yield* partition(old.pk!)).toEqual([])
        expect(yield* partition(current.pk!)).toEqual([])
      }).pipe(provide),
    )
  })

  describe("retained history of an item 1.36 put once", () => {
    // 1.36 snapshotted version 1 when it put the item, under its 1.36 key; a
    // write after the move snapshots version 1 again, under the current key.
    // The move takes that snapshot along, so no version is under both keys.
    const reading = (deviceId: string, label: string) => ({
      deviceId,
      seq: -20,
      label,
      serial: -2000 - ++serials,
    })
    const seedReading = (deviceId: string) =>
      Effect.gen(function* () {
        const db = yield* makeDb
        const record = reading(deviceId, "x")
        yield* db.entities.Readings.put(record).asEffect()
        const history = yield* demoteHistory(record)
        yield* demote(Readings, record)
        return { record, ...history }
      })
    const versionsOf = (deviceId: string) =>
      Effect.gen(function* () {
        const db = yield* makeDb
        const versions = yield* db.entities.Readings.versions({ deviceId, seq: -20 }).collect()
        return versions.map((r) => [versionOf(r), r.label])
      })
    const under136 = (pk: string, prefix: string) =>
      Effect.map(partition(pk), (rows) => rows.filter((row) => String(row.sk).startsWith(prefix)))

    type Seeded = ReturnType<typeof reading>
    const writes = {
      put: (record: Seeded) =>
        Effect.flatMap(makeDb, (db) =>
          db.entities.Readings.put({ ...record, label: "x2" }).asEffect(),
        ),
      update: (record: Seeded) =>
        Effect.flatMap(makeDb, (db) =>
          db.entities.Readings.update({ deviceId: record.deviceId, seq: -20 })
            .set({ label: "x2" })
            .asEffect(),
        ),
      upsert: (record: Seeded) =>
        Effect.flatMap(makeDb, (db) =>
          db.entities.Readings.upsert({ ...record, label: "x2" }).asEffect(),
        ),
      "soft delete": (record: Seeded) =>
        Effect.flatMap(makeDb, (db) =>
          db.entities.Readings.delete({ deviceId: record.deviceId, seq: -20 }).asEffect(),
        ),
    } as const

    for (const [name, write] of Object.entries(writes)) {
      it.effect(`${name}: versions() holds version 1 once; nothing stays under the 1.36 key`, () =>
        Effect.gen(function* () {
          const deviceId = `history-${name}`
          const { record, old, versions136 } = yield* seedReading(deviceId)
          expect((yield* under136(old.pk!, versions136)).length).toBe(1)
          yield* write(record)
          expect(yield* under136(old.pk!, versions136)).toEqual([])
          expect(yield* getRaw(old)).toBeUndefined()
          // Version 1, once; version 2 is the item's, not yet snapshotted.
          expect(yield* versionsOf(deviceId)).toEqual([[1, "x"]])
        }).pipe(provide),
      )
    }

    it.effect("restore of a 1.36 tombstone: the version it restores is held once", () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        const deviceId = "history-restore"
        const record = reading(deviceId, "r")
        yield* db.entities.Readings.put(record).asEffect()
        yield* db.entities.Readings.delete({ deviceId, seq: -20 }).asEffect()
        const { current, old, versions136 } = yield* demoteHistory(record)
        const restored = yield* db.entities.Readings.restore({ deviceId, seq: -20 })
        expect(restored.label).toBe("r")
        expect(fromAttributeMap((yield* getRaw(current))!).version).toBe(2)
        expect(yield* under136(old.pk!, versions136)).toEqual([])
        expect(yield* versionsOf(deviceId)).toEqual([[1, "r"]])
      }).pipe(provide),
    )

    it.effect("versions() reads a version stored under both keys once, from its current key", () =>
      Effect.gen(function* () {
        const deviceId = "history-twin"
        const { old, versions136 } = yield* seedReading(deviceId)
        // The same snapshot under its current key too, as a copy from a backup.
        const [snapshot] = yield* under136(old.pk!, versions136)
        const primary = Readings.indexes.primary
        const currentSk = KeyComposer.composeSk(AppSchema, "Reading", 1, primary, { seq: -20 })
        const item = KeyComposer.composeHistoryItemSegment(
          AppSchema,
          "Reading",
          1,
          primary,
          currentSk,
        )!
        const client = yield* DynamoClient
        yield* client.putItem({
          TableName: tableName,
          Item: toAttributeMap({
            ...snapshot,
            sk: DynamoSchema.composeVersionKey(AppSchema, "Reading", 1, { item }),
          }),
        })
        expect(yield* versionsOf(deviceId)).toEqual([[1, "x"]])
      }).pipe(provide),
    )
  })

  describe("time series", () => {
    it.effect("append moves the current item, then applies", () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.entities.Gauges.append({ gaugeId: -6, at: 1, level: 10 }).asEffect()
        const { current, old } = yield* demotePartition(Gauges, { gaugeId: -6 })
        const stale = yield* db.entities.Gauges.append({ gaugeId: -6, at: 0, level: 1 })
          .asEffect()
          .pipe(Effect.flip)
        expect(stale._tag).toBe("StaleAppend")
        expect(yield* getRaw(old)).toBeUndefined()
        const applied = yield* db.entities.Gauges.append({
          gaugeId: -6,
          at: 2,
          level: 20,
        }).asEffect()
        expect(applied.current.level).toBe(20)
        const live = fromAttributeMap((yield* getRaw(current))!)
        expect(live.at).toBe(2)
        // The new event is under the current partition; the first, under the 1.36 one.
        const events = (yield* partition(current.pk!)).filter((r) => String(r.sk).includes("#e#"))
        expect(events.map((e) => e.at)).toEqual([2])
        const oldEvents = (yield* partition(old.pk!)).filter((r) => String(r.sk).includes("#e#"))
        expect(oldEvents.map((e) => e.at)).toEqual([1])
      }).pipe(provide),
    )
  })
  describe("a 1.36 row at another value's key", () => {
    /** Each pair: a value holding `%XX`, and the value whose escaped text that spells. */
    const PAIRS = [
      { spelled: "foo%20bar", value: "foo bar" },
      { spelled: "x%23y", value: "x#y" },
    ] as const
    let owners = 0
    const memoKeys = (owner: string, title: string) => {
      const record = { owner, title }
      return {
        current: KeyComposer.composeAllKeys(AppSchema, "Memo", 1, Memos.indexes, record) as Keys,
        old: KeyText136.composeAllKeys(AppSchema, "Memo", 1, Memos.indexes, record),
      }
    }
    /** Write `title`'s memo as 1.36 did: every key in its 1.36 text. */
    const seed136 = (owner: string, title: string, body: string) =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        const { old } = memoKeys(owner, title)
        yield* client.putItem({
          TableName: tableName,
          Item: { ...toAttributeMap({ owner, title, body, ...old }), __edd_e__: { S: "Memo" } },
        })
      })
    const bodyAt = ({ pk, sk }: Keys) =>
      getRaw({ pk: pk!, sk: sk! }).pipe(
        Effect.map((row) => (row === undefined ? undefined : fromAttributeMap(row).body)),
      )
    /** The current key of `title`'s note — a `Note` or a `Page`. */
    const noteKey = (entityType: "Note" | "Page", owner: string, title: string) =>
      KeyComposer.composeIndexKeys(AppSchema, entityType, 1, Notes.indexes.primary, {
        owner,
        title,
      }) as Keys

    for (const { spelled, value } of PAIRS) {
      it.effect(`${spelled}'s 1.36 row is not ${value}'s item to read, update or delete`, () =>
        Effect.gen(function* () {
          const db = yield* makeDb
          const owner = `alias${++owners}`
          expect(memoKeys(owner, spelled).old.sk).toBe(memoKeys(owner, value).current.sk)
          yield* seed136(owner, spelled, "theirs")
          const key = { owner, title: value }
          expect((yield* db.entities.Memos.get(key).asEffect().pipe(Effect.flip))._tag).toBe(
            "ItemNotFound",
          )
          expect((yield* db.entities.Memos.byTitle(key).collect()).length).toBe(0)
          const found = yield* db.entities.Memos.byTitle({ owner, title: spelled }).collect()
          expect(found.map((m) => m.body)).toEqual(["theirs"])
          const updated = yield* db.entities.Memos.update(key)
            .set({ body: "hijack" })
            .asEffect()
            .pipe(Effect.flip)
          expect(updated._tag).toBe("ItemNotFound")
          yield* db.entities.Memos.delete(key).asEffect()
          const theirs = yield* db.entities.Memos.get({ owner, title: spelled }).asEffect()
          expect(theirs.body).toBe("theirs")
        }).pipe(provide),
      )

      it.effect(`put and upsert of ${value} move ${spelled}'s 1.36 row out of the way`, () =>
        Effect.gen(function* () {
          const db = yield* makeDb
          for (const write of ["put", "upsert"] as const) {
            const owner = `alias${++owners}`
            yield* seed136(owner, spelled, "theirs")
            yield* db.entities.Memos[write]({ owner, title: value, body: "mine" }).asEffect()
            expect(yield* bodyAt(memoKeys(owner, value).current)).toBe("mine")
            expect(yield* bodyAt(memoKeys(owner, spelled).current)).toBe("theirs")
            const both = yield* db.entities.Memos.byTitle({ owner }).collect()
            expect(both.map((m) => m.body).sort()).toEqual(["mine", "theirs"])
          }
        }).pipe(provide),
      )

      it.effect(`writes of ${spelled} leave ${value}'s current row at its 1.36 key`, () =>
        Effect.gen(function* () {
          const db = yield* makeDb
          const writes = [
            [
              "Note",
              (owner: string) => db.entities.Notes.put({ owner, title: spelled, body: "theirs" }),
            ],
            [
              "Note",
              (owner: string) =>
                db.entities.Notes.create({ owner, title: spelled, body: "theirs" }),
            ],
            [
              "Page",
              (owner: string) => db.entities.Pages.put({ owner, title: spelled, body: "theirs" }),
            ],
            [
              "Page",
              (owner: string) =>
                db.entities.Pages.create({ owner, title: spelled, body: "theirs" }),
            ],
            [
              "Page",
              (owner: string) =>
                db.entities.Pages.upsert({ owner, title: spelled, body: "theirs" }),
            ],
          ] as const
          for (const [entityType, write] of writes) {
            const owner = `alias${++owners}`
            const entity = entityType === "Page" ? db.entities.Pages : db.entities.Notes
            yield* entity.put({ owner, title: value, body: "mine" }).asEffect()
            yield* write(owner).asEffect()
            expect(yield* bodyAt(noteKey(entityType, owner, value))).toBe("mine")
            expect(yield* bodyAt(noteKey(entityType, owner, spelled))).toBe("theirs")
          }
          // A restore: the tombstone's item is not the row at its 1.36 key.
          const owner = `alias${++owners}`
          const key = { owner, title: spelled }
          yield* db.entities.Pages.put({ ...key, body: "theirs" }).asEffect()
          yield* db.entities.Pages.delete(key).asEffect()
          yield* db.entities.Pages.put({ owner, title: value, body: "mine" }).asEffect()
          expect((yield* db.entities.Pages.restore(key)).body).toBe("theirs")
          expect(yield* bodyAt(noteKey("Page", owner, value))).toBe("mine")
        }).pipe(provide),
      )

      it.effect(`${value}'s current row is not ${spelled}'s item under its 1.36 key`, () =>
        Effect.gen(function* () {
          const db = yield* makeDb
          const owner = `alias${++owners}`
          yield* db.entities.Memos.put({ owner, title: value, body: "mine" }).asEffect()
          const key = { owner, title: spelled }
          expect((yield* db.entities.Memos.get(key).asEffect().pipe(Effect.flip))._tag).toBe(
            "ItemNotFound",
          )
          yield* db.entities.Memos.delete(key).asEffect()
          expect(yield* bodyAt(memoKeys(owner, value).current)).toBe("mine")
        }).pipe(provide),
      )
    }

    it.effect("a retained `a%20b` continues its own versions, not `a b`'s", () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        const client = yield* DynamoClient
        const owner = `alias${++owners}`
        const versionOf = (title: string) =>
          getRaw(noteKey("Page", owner, title)).pipe(
            Effect.map((row) => (row === undefined ? undefined : fromAttributeMap(row).version)),
          )
        // `a%20b` deleted under 1.36, its versions 1–2 retained under its 1.36
        // prefix: `a b`'s current one.
        const old = KeyText136.composeIndexKeys(AppSchema, "Page", 1, Pages.indexes.primary, {
          owner,
          title: "a%20b",
        })
        expect(old.sk).toBe(noteKey("Page", owner, "a b").sk)
        for (const version of [1, 2]) {
          const sk = DynamoSchema.composeVersionKey(AppSchema, "Page", version, {
            item: KeyComposer.composeHistoryItemSegment(
              AppSchema,
              "Page",
              1,
              Pages.indexes.primary,
              old.sk!,
            )!,
          })
          yield* client.putItem({
            TableName: tableName,
            Item: {
              ...toAttributeMap({ owner, title: "a%20b", body: `v${version}`, version }),
              pk: { S: old.pk! },
              sk: { S: sk },
              __edd_e__: { S: "Page" },
            },
          })
        }
        // `a b` starts past them, under the prefix it shares with them.
        for (const body of ["v3", "v4", "v5"]) {
          yield* db.entities.Pages.put({ owner, title: "a b", body }).asEffect()
        }
        expect(yield* versionOf("a b")).toBe(5)
        // `a%20b` continues its own: version 3, not 6.
        yield* db.entities.Pages.create({ owner, title: "a%20b", body: "mine" }).asEffect()
        expect(yield* versionOf("a%20b")).toBe(3)
        yield* db.entities.Pages.update({ owner, title: "a%20b" })
          .set({ body: "mine 2" })
          .expectedVersion(3)
          .asEffect()
        expect(yield* versionOf("a%20b")).toBe(4)
      }).pipe(provide),
    )

    it.effect("purge of `a b` leaves `a b#c`'s 1.36 row", () =>
      Effect.gen(function* () {
        const db = yield* makeDb
        const owner = `alias${++owners}`
        yield* seed136(owner, "a b", "mine")
        yield* seed136(owner, "a b#c", "theirs")
        expect(
          memoKeys(owner, "a b#c").old.sk!.startsWith(`${memoKeys(owner, "a b").old.sk}#`),
        ).toBe(true)
        yield* db.entities.Memos.purge({ owner, title: "a b" })
        expect(yield* bodyAt(memoKeys(owner, "a b").old)).toBeUndefined()
        expect(yield* bodyAt(memoKeys(owner, "a b#c").old)).toBe("theirs")
      }).pipe(provide),
    )
  })

  describe("concurrent first writes of an unmoved item", () => {
    for (const [name, entity] of [
      ["unversioned, untimestamped", "Notes"],
      ["timestamps only", "Stamped"],
    ] as const) {
      it.effect(`eight concurrent updates (${name}) all apply`, () =>
        Effect.gen(function* () {
          const db = yield* makeDb
          const record = { owner: `race-${entity}`, title: "new york", body: "1.36" }
          yield* db.entities[entity].put(record).asEffect()
          const { current, old } = yield* demote(entity === "Notes" ? Notes : Stamped, record)
          const results = yield* Effect.all(
            Array.from({ length: 8 }, (_, i) =>
              db.entities[entity]
                .update({ owner: record.owner, title: record.title })
                .set({ body: `w${i}` })
                .asEffect()
                .pipe(Effect.exit),
            ),
            { concurrency: 8 },
          )
          expect(results.filter((exit) => exit._tag === "Failure")).toEqual([])
          expect(yield* getRaw(old)).toBeUndefined()
          expect(String(fromAttributeMap((yield* getRaw(current))!).body)).toMatch(/^w\d$/)
        }).pipe(provide),
      )
    }
  })

  describe("history of a string-encoded numeric orderBy", () => {
    /** Events 2 and 9 keyed as 1.36 did (`#e#2`), then 10 as 1.37 does. */
    const seeded = (tickId: number) =>
      Effect.gen(function* () {
        const db = yield* makeDb
        const client = yield* DynamoClient
        for (const t of [2, 9]) {
          yield* db.entities.Ticks.append({ tickId, at: t, level: t }).asEffect()
        }
        const pk = KeyComposer.composePk(AppSchema, "Tick", Ticks.indexes.primary, { tickId })
        const currentSk = KeyComposer.composeSk(AppSchema, "Tick", 1, Ticks.indexes.primary, {})
        for (const row of yield* partition(pk)) {
          const sk = String(row.sk)
          if (!sk.startsWith(`${currentSk}#e#`)) continue
          const old = KeyText136.composeEventSk(currentSk, row.at, AppSchema.casing)
          expect(old).not.toBe(sk)
          yield* client.putItem({
            TableName: tableName,
            Item: toAttributeMap({ ...row, sk: old }),
          })
          yield* client.deleteItem({ TableName: tableName, Key: toAttributeMap({ pk, sk }) })
        }
        yield* db.entities.Ticks.append({ tickId, at: 10, level: 10 }).asEffect()
        return db
      })

    it.effect("history reads the 1.36 form first, then the current one", () =>
      Effect.gen(function* () {
        const db = yield* seeded(1)
        const key = { tickId: 1 }
        expect((yield* db.entities.Ticks.history(key).collect()).map((e) => e.at)).toEqual([
          2, 9, 10,
        ])
        expect(
          (yield* db.entities.Ticks.history(key).reverse().collect()).map((e) => e.at),
        ).toEqual([10, 9, 2])
        expect(yield* db.entities.Ticks.history(key).count()).toBe(3)
        // Paged one event at a time, each once.
        const paged = yield* db.entities.Ticks.history(key)
          .pageSize(1)
          .paginate()
          .pipe(Stream.runCollect)
        expect([...paged].map((e) => e.at)).toEqual([2, 9, 10])
      }).pipe(provide),
    )

    type Bound = (t: any, ops: any) => any
    const BOUNDS: ReadonlyArray<readonly [string, Bound, ReadonlyArray<number>]> = [
      ["gt 5", (t, { gt }) => gt(t.at, 5), [9, 10]],
      ["gte 9", (t, { gte }) => gte(t.at, 9), [9, 10]],
      ["lt 9", (t, { lt }) => lt(t.at, 9), [2]],
      ["lte 9", (t, { lte }) => lte(t.at, 9), [2, 9]],
      ["between 2 and 9", (t, { between }) => between(t.at, 2, 9), [2, 9]],
      ["eq 9", (t, { eq }) => eq(t.at, 9), [9]],
      ["beginsWith 10", (t, { beginsWith }) => beginsWith(t.at, 10), [10]],
    ]
    let ticks = 10
    for (const [name, bound, expected] of BOUNDS) {
      it.effect(`.where(${name}) holds on the numbers, forward and reverse`, () =>
        Effect.gen(function* () {
          const tickId = ++ticks
          const db = yield* seeded(tickId)
          const forward = yield* db.entities.Ticks.history({ tickId }).where(bound).collect()
          expect(forward.map((e) => e.at)).toEqual(expected)
          const reverse = yield* db.entities.Ticks.history({ tickId })
            .where(bound)
            .reverse()
            .collect()
          expect(reverse.map((e) => e.at)).toEqual([...expected].reverse())
        }).pipe(provide),
      )
    }
  })
})
