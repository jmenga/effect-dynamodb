/**
 * `db.tables.<Table>.rekey()` (#171) — connected tests against DynamoDB Local.
 *
 * Each test seeds a fresh table with every row kind as 1.36 wrote it —
 * written by 1.37, then rewritten under the key text `KeyText136` composes
 * (the composer the golden vectors from the published 1.36.0 pin) with the
 * raw client — next to rows under their current keys, a row stored under
 * both keys, and rows no member owns. Then:
 *
 * - a dry run counts what would move and changes nothing;
 * - a run (in parallel segments) moves every row where a 1.37 write puts it
 *   — the six canonical GSI shapes answer their queries — and reports the
 *   conflict and the skipped rows; a rerun moves nothing;
 * - a run interrupted mid-scan resumes from the last token it delivered;
 * - a soft-deleted item's kept reservations move to, and name, its current
 *   key: its values stay taken and it restores;
 * - an aggregate update or delete that lands while `rekey` moves the
 *   aggregate overwrites nothing, and the run ends with the move done;
 * - an aggregate whose edge keys alias (one's current key is another's 1.36
 *   key) moves along the chain;
 * - a writer appending while a stream moves overwrites nothing and loses
 *   nothing; a stream written beside its old rows is reported and left; a
 *   stream id holding `#` moves.
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
import { Config, Effect, Layer, Option, Schema } from "effect"
import { describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"

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

const AppSchema = DynamoSchema.make({ name: "rekey", version: 1, escapeKeys: true })
/** What wrote the rows `rekey` moves below: 1.36, and `escapeKeys` off. */
const Old = KeyText136.schema136(AppSchema)

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
}) {}

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

class Note extends Schema.Class<Note>("Note")({
  owner: Schema.String,
  title: Schema.String,
  body: Schema.String,
}) {}

const Notes = Entity.make({
  model: Note,
  entityType: "Note",
  primaryKey: {
    pk: { field: "pk", composite: ["owner"] },
    sk: { field: "sk", composite: ["title"] },
  },
})

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

class Badge extends Schema.Class<Badge>("Badge")({
  owner: Schema.String,
  tag: Schema.String,
  code: Schema.Number,
}) {}

class Card extends Schema.Class<Card>("Card")({
  cardId: Schema.Number,
  name: Schema.String,
}) {}

/**
 * Soft-deleted with their reservations kept: a badge's key text is the same
 * as 1.36's and its unique value's is not; a card's the other way. Made
 * twice: a table configures its own entities.
 */
const badges = () =>
  Entity.make({
    model: Badge,
    entityType: "Badge",
    primaryKey: {
      pk: { field: "pk", composite: ["owner"] },
      sk: { field: "sk", composite: ["tag"] },
    },
    unique: { code: ["code"] },
    softDelete: { preserveUnique: true },
  })
const cards = () =>
  Entity.make({
    model: Card,
    entityType: "Card",
    primaryKey: {
      pk: { field: "pk", composite: ["cardId"] },
      sk: { field: "sk", composite: [] },
    },
    unique: { name: ["name"] },
    softDelete: { preserveUnique: true },
  })
const Badges = badges()
const Cards = cards()

class Reading extends Schema.Class<Reading>("Reading")({
  deviceId: Schema.String,
  seq: Schema.Number,
  label: Schema.String,
  serial: Schema.Number,
}) {}

/** Retained, keyed by a number in its sort key: its history rows carry the item's segment. */
const Readings = Entity.make({
  model: Reading,
  entityType: "Reading",
  primaryKey: {
    pk: { field: "pk", composite: ["deviceId"] },
    sk: { field: "sk", composite: ["seq"] },
  },
  unique: { serial: ["serial"] },
  timestamps: true,
  versioned: { retain: true },
  softDelete: true,
})

const MainTable = Table.make({
  schema: AppSchema,
  entities: { Meters, Notes, Docs, Gauges, Badges, Cards, Readings },
})

class Stop extends Schema.Class<Stop>("Stop")({
  label: Schema.String,
  note: Schema.String,
}) {}

class Route extends Schema.Class<Route>("Route")({
  id: Schema.Number,
  area: Schema.String,
  name: Schema.String,
  stops: Schema.Array(Stop),
}) {}

const Routes = Aggregate.make(Route, {
  table: MainTable,
  schema: AppSchema,
  pk: { field: "pk", composite: ["id"] },
  collection: { name: "routes" },
  root: { entityType: "RouteItem" },
  edges: {
    stops: Aggregate.many({ entityType: "RouteStop", sk: { composite: ["label"] } }),
  },
  list: {
    index: "gsi1",
    name: "routelist",
    pk: { field: "gsi1pk", composite: ["area"] },
    sk: { field: "gsi1sk", composite: ["id"] },
  },
})

/** An aggregate under a partition key whose text did not change. */
class Trail extends Schema.Class<Trail>("Trail")({
  name: Schema.String,
  stops: Schema.Array(Stop),
}) {}

const Trails = Aggregate.make(Trail, {
  table: MainTable,
  schema: AppSchema,
  pk: { field: "pk", composite: ["name"] },
  collection: { name: "trails" },
  root: { entityType: "TrailItem" },
  edges: {
    stops: Aggregate.many({ entityType: "TrailStop", sk: { composite: ["label"] } }),
  },
})

class Deposited extends Schema.TaggedClass<Deposited>()("Deposited", {
  amount: Schema.Number,
}) {}

const Ledger = EventStore.makeStream({
  table: MainTable,
  streamName: "Ledger",
  events: [Deposited],
  streamId: { composite: ["ledgerId"] },
})

/** A stream id of two composites, the first a string that may hold `#`. */
const Accounts = EventStore.makeStream({
  table: MainTable,
  streamName: "Accounts",
  events: [Deposited],
  streamId: { composite: ["tenant", "n"] },
})

/** Stream ids are typed as strings; a number — an untyped caller's — is the one whose text changed. */
const ledger = (id: number | string) =>
  ({ ledgerId: id }) as unknown as { readonly ledgerId: string }

const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})

const makeDb = DynamoClient.make({
  entities: { Meters, Notes, Docs, Gauges, Badges, Cards, Readings },
  aggregates: { Routes, Trails },
  tables: { MainTable },
})

let tables = 0

/** Run `body` over a fresh table, deleted afterwards. */
const withTable = <A, E>(body: (tableName: string) => Effect.Effect<A, E, any>) => {
  const tableName = `rekey-${Date.now()}-${tables++}`
  const create = Effect.gen(function* () {
    const client = yield* DynamoClient
    yield* client.createTable({
      TableName: tableName,
      BillingMode: "PAY_PER_REQUEST",
      ...Table.definition(MainTable),
    })
  })
  const drop = Effect.gen(function* () {
    const client = yield* DynamoClient
    yield* client.deleteTable({ TableName: tableName })
  }).pipe(Effect.ignore)
  return Effect.acquireUseRelease(
    create,
    () => body(tableName),
    () => drop,
  ).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(ClientLayer, MainTable.layer({ name: tableName }))),
  ) as Effect.Effect<A, E>
}

// ---------------------------------------------------------------------------
// Rows as 1.36 wrote them
// ---------------------------------------------------------------------------

type Row = Record<string, AttributeValue>

const tableNameOf = Effect.map(Effect.service(MainTable.Tag), (config) => config.name)

const getRaw = (key: Record<string, string>) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const { Item } = yield* client.getItem({
      TableName: yield* tableNameOf,
      Key: toAttributeMap(key),
      ConsistentRead: true,
    })
    return Item
  })

const scanAll = Effect.gen(function* () {
  const client = yield* DynamoClient
  const TableName = yield* tableNameOf
  const rows: Array<Row> = []
  let start: Row | undefined
  do {
    const page = yield* client.scan({
      TableName,
      ConsistentRead: true,
      ...(start !== undefined && { ExclusiveStartKey: start }),
    })
    rows.push(...(page.Items ?? []))
    start = page.LastEvaluatedKey as Row | undefined
  } while (start !== undefined)
  return rows
})

const partition = (pk: string) =>
  Effect.map(scanAll, (rows) => rows.filter((row) => row.pk?.S === pk))

/** Replace `row` with `next`. */
const rewrite = (row: Row, next: Row) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const TableName = yield* tableNameOf
    yield* client.deleteItem({ TableName, Key: { pk: row.pk!, sk: row.sk! } })
    yield* client.putItem({ TableName, Item: next })
  })

const deleteRaw = (key: Record<string, string>) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    yield* client.deleteItem({ TableName: yield* tableNameOf, Key: toAttributeMap(key) })
  })

const putRaw = (row: Row) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    yield* client.putItem({ TableName: yield* tableNameOf, Item: row })
  })

/** Every row of partition `from`, rewritten under partition `to`. */
const demotePartition = (from: string, to: string, change: (row: Row) => Row = (row) => row) =>
  Effect.gen(function* () {
    expect(to).not.toBe(from)
    const rows = yield* partition(from)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) yield* rewrite(row, change({ ...row, pk: { S: to } }))
    return rows
  })

const meter = (meterId: number, serial: number, changed: boolean) => ({
  site: "s",
  meterId,
  serial,
  zone: "z",
  reading: changed ? -2.5 : 2,
  region: "emea",
  country: "uk",
  city: changed ? "san jose" : "sanjose",
  shelf: "top",
  bin: changed ? -1 : 1,
  status: "active",
  label: changed ? "a b" : "ab",
  deviceBinding: changed ? -9 : 9,
})

const meterKeys = (record: Record<string, unknown>) => ({
  current: KeyComposer.composeAllKeys(AppSchema, "Meter", 1, Meters.indexes, record) as Record<
    string,
    string
  >,
  old: KeyComposer.composeAllKeys(Old, "Meter", 1, Meters.indexes, record) as Record<
    string,
    string
  >,
})

const primaryOf = (keys: Record<string, string>) => ({ pk: keys.pk!, sk: keys.sk! })

/** A unique constraint's sentinel keys for `value`: now, and as 1.36 composed them. */
const uniqueKeys = (entityType: string, constraint: string, value: string | number) => {
  const current = DynamoSchema.composeUniqueKey(AppSchema, entityType, constraint, [
    KeyComposer.serializeValue(value),
  ])
  const old = DynamoSchema.composeUniqueKey(Old, entityType, constraint, [
    KeyComposer.serializeValue136(value),
  ])
  return { current: { pk: current.pk, sk: current.sk }, old: { pk: old.pk, sk: old.sk } }
}

const sentinelKeys = (value: number) => uniqueKeys("Meter", "serial", value)

/** Move a meter's sentinel to its 1.36 key, owned by the item at `owner`. */
const demoteSentinel = (serial: number, owner: { readonly pk: string; readonly sk: string }) =>
  Effect.gen(function* () {
    const keys = sentinelKeys(serial)
    expect(keys.old).not.toEqual(keys.current)
    const held = (yield* getRaw(keys.current))!
    yield* rewrite(held, {
      ...held,
      ...toAttributeMap({ ...keys.old, _entity_pk: owner.pk, _entity_sk: owner.sk }),
    })
    return keys
  })

/** A snapshot's version: `versions()` returns the model, which doesn't declare it. */
const versionOf = (item: unknown) => (item as { readonly version: number }).version

/**
 * A reading 1.36 wrote, and soft-deleted when `deleted`: its item (or
 * tombstone), its version snapshots and its sentinel under their 1.36 keys.
 */
const seedReading = (seq: number, label: string, deleted = false) =>
  Effect.gen(function* () {
    const db = yield* makeDb
    const record = { deviceId: "dev-r", seq, label, serial: seq * 100 }
    yield* db.entities.Readings.put(record).asEffect()
    if (deleted) yield* db.entities.Readings.delete({ deviceId: "dev-r", seq }).asEffect()
    const primary = Readings.indexes.primary
    const now = KeyComposer.composeIndexKeys(AppSchema, "Reading", 1, primary, record) as Record<
      string,
      string
    >
    const old = KeyComposer.composeIndexKeys(Old, "Reading", 1, primary, record) as Record<
      string,
      string
    >
    expect(old.sk).not.toBe(now.sk)
    const segment = (liveSk: string) => ({
      item: KeyComposer.composeHistoryItemSegment(AppSchema, "Reading", 1, primary, liveSk)!,
    })
    const versions = DynamoSchema.composeVersionKeyPrefix(AppSchema, "Reading", segment(now.sk!))
    const tombstones = DynamoSchema.composeDeletedKeyPrefix(AppSchema, "Reading", segment(now.sk!))
    for (const row of yield* partition(now.pk!)) {
      const sk = row.sk!.S!
      const tail = sk.slice(sk.lastIndexOf("#") + 1)
      const sk136 =
        sk === now.sk
          ? old.sk
          : sk.startsWith(versions)
            ? DynamoSchema.composeVersionKey(AppSchema, "Reading", Number(tail), segment(old.sk!))
            : sk.startsWith(tombstones)
              ? DynamoSchema.composeDeletedKey(AppSchema, "Reading", tail, segment(old.sk!))
              : undefined
      if (sk136 !== undefined) yield* rewrite(row, { ...row, sk: { S: sk136 } })
    }
    if (!deleted) {
      const sentinel = uniqueKeys("Reading", "serial", record.serial)
      const held = (yield* getRaw(sentinel.current))!
      yield* rewrite(held, {
        ...held,
        ...toAttributeMap({ ...sentinel.old, _entity_pk: old.pk, _entity_sk: old.sk }),
      })
    }
    return {
      now,
      old,
      versions136: DynamoSchema.composeVersionKeyPrefix(AppSchema, "Reading", segment(old.sk!)),
    }
  })

const routePk = (id: number) => ({
  now: DynamoSchema.composeCollectionKey(AppSchema, "routes", [KeyComposer.serializeValue(id)]),
  old: DynamoSchema.composeCollectionKey(Old, "routes", [KeyComposer.serializeValue136(id)]),
})
const stopSk = (label: string) =>
  DynamoSchema.composeKey(AppSchema, "RouteStop", [KeyComposer.escapeKeyText(label, "lowercase")])
const stopSk136 = (label: string) => DynamoSchema.composeKey(AppSchema, "RouteStop", [label])
const trailStopSk = (label: string) =>
  DynamoSchema.composeKey(AppSchema, "TrailStop", [KeyComposer.escapeKeyText(label, "lowercase")])
const trailStopSk136 = (label: string) => DynamoSchema.composeKey(AppSchema, "TrailStop", [label])
const cardPk = {
  now: KeyComposer.composePk(AppSchema, "Card", Cards.indexes.primary, { cardId: -3 }),
  old: KeyComposer.composePk(Old, "Card", Cards.indexes.primary, { cardId: -3 }),
}

const streamPk = (id: number) => ({
  now: DynamoSchema.composeKey(AppSchema, "Ledger", [KeyComposer.serializeValue(id)]),
  old: DynamoSchema.composeKey(Old, "Ledger", [KeyComposer.serializeValue136(id)]),
})
const docPk = {
  now: KeyComposer.composePk(AppSchema, "Doc", Docs.indexes.primary, { docId: -5 }),
  old: KeyComposer.composePk(Old, "Doc", Docs.indexes.primary, { docId: -5 }),
}
const gaugePk = {
  now: KeyComposer.composePk(AppSchema, "Gauge", Gauges.indexes.primary, { gaugeId: -6 }),
  old: KeyComposer.composePk(Old, "Gauge", Gauges.indexes.primary, { gaugeId: -6 }),
}
const noteKeys = {
  current: KeyComposer.composeIndexKeys(AppSchema, "Note", 1, Notes.indexes.primary, {
    owner: "o",
    title: "new york",
  }) as Record<string, string>,
  old: KeyComposer.composeIndexKeys(Old, "Note", 1, Notes.indexes.primary, {
    owner: "o",
    title: "new york",
  }),
}

/** Route -5, as 1.36 wrote it: its partition, its edges' keys and its list sort key. */
const seedRoute = Effect.gen(function* () {
  const db = yield* makeDb
  const stops = [new Stop({ label: "a b", note: "1" }), new Stop({ label: "c", note: "2" })]
  yield* db.aggregates.Routes.create({ id: -5, area: "north", name: "r", stops })
  yield* demotePartition(routePk(-5).now, routePk(-5).old, (row) => {
    const edge = stops.find((stop) => stopSk(stop.label) === row.sk!.S)
    return {
      ...row,
      ...(edge === undefined ? {} : { sk: { S: stopSk136(edge.label) } }),
      ...(row.gsi1sk === undefined
        ? {}
        : {
            gsi1sk: {
              S: DynamoSchema.composeCollectionKey(AppSchema, "routelist", [
                KeyComposer.serializeValue136(-5),
              ]),
            },
          }),
    }
  })
})

/**
 * Every row kind under its 1.36 keys, rows under their current keys, a meter
 * and an aggregate root under both keys, and two rows no member owns. Returns
 * what a run moves.
 */
const seed = Effect.gen(function* () {
  const db = yield* makeDb
  // Meters: -7 moves (item + sentinel); 8 is current; 9 has only its index keys
  // and sentinel in 1.36 text; -11 is under both keys.
  for (const [id, serial, changed] of [
    [-7, -1001, true],
    [8, 2002, false],
    [9, -3003, true],
    [-11, -4004, true],
  ] as const) {
    yield* db.entities.Meters.put(meter(id, serial, changed)).asEffect()
  }
  const m7 = meterKeys(meter(-7, -1001, true))
  const row7 = (yield* getRaw(primaryOf(m7.current)))!
  yield* rewrite(row7, { ...row7, ...toAttributeMap(m7.old) })
  yield* demoteSentinel(-1001, primaryOf(m7.old))
  const m9 = meterKeys(meter(9, -3003, true))
  expect(primaryOf(m9.old)).toEqual(primaryOf(m9.current))
  const row9 = (yield* getRaw(primaryOf(m9.current)))!
  yield* putRaw({ ...row9, ...toAttributeMap(m9.old) })
  yield* demoteSentinel(-3003, primaryOf(m9.current))
  const m11 = meterKeys(meter(-11, -4004, true))
  const row11 = (yield* getRaw(primaryOf(m11.current)))!
  yield* putRaw({ ...row11, ...toAttributeMap(m11.old) })

  // A note whose sort key text is escaped now.
  yield* db.entities.Notes.put({ owner: "o", title: "new york", body: "b" }).asEffect()
  const note = (yield* getRaw(primaryOf(noteKeys.current)))!
  yield* rewrite(note, { ...note, ...toAttributeMap(noteKeys.old) })

  // A doc's snapshots and tombstone; a gauge's item and events.
  yield* db.entities.Docs.put({ docId: -5, title: "v1" }).asEffect()
  yield* db.entities.Docs.update({ docId: -5 }).set({ title: "v2" }).asEffect()
  yield* db.entities.Docs.delete({ docId: -5 }).asEffect()
  const docRows = yield* demotePartition(docPk.now, docPk.old)
  for (const at of [1, 2]) {
    yield* db.entities.Gauges.append({ gaugeId: -6, at, level: at }).asEffect()
  }
  yield* demotePartition(gaugePk.now, gaugePk.old)

  // An aggregate: its partition, its edges' keys and its list sort key.
  yield* seedRoute

  // An aggregate whose root is under both partition keys: a conflict.
  yield* db.aggregates.Routes.create({
    id: -6,
    area: "south",
    name: "s",
    stops: [new Stop({ label: "d", note: "3" })],
  })
  const root6 = (yield* partition(routePk(-6).now)).find((row) => row.__edd_e__?.S === "RouteItem")!
  yield* putRaw({ ...root6, pk: { S: routePk(-6).old } })

  // A stream 1.36 started, and one under its current key.
  yield* Ledger.append(
    ledger(-4),
    [1, 2, 3].map((amount) => new Deposited({ amount })),
    0,
  )
  yield* demotePartition(streamPk(-4).now, streamPk(-4).old)
  yield* Ledger.append(ledger(-3), [new Deposited({ amount: 1 })], 0)

  // Rows no member owns.
  yield* putRaw(toAttributeMap({ pk: "plain", sk: "1" }))
  yield* putRaw(toAttributeMap({ pk: "other", sk: "1", __edd_e__: "Nobody" }))

  const snapshots = docRows.filter((row) => row.sk?.S?.includes("#v#")).length
  expect(snapshots).toBeGreaterThan(0)
  return {
    moved: {
      item: 3, // meter -7, the note, the gauge's current item
      snapshot: snapshots,
      tombstone: 1,
      outbox: 0,
      event: 2,
      aggregate: 3, // the route's root and its two stops
      stream: 3,
    },
    m7,
    m9,
    m11,
    root6: { pk: routePk(-6).old, sk: root6.sk!.S! },
  }
})

/** Every row still under one of the seeded 1.36 keys. */
const leftUnder136 = Effect.gen(function* () {
  const rows = yield* scanAll
  const partitions = new Set([docPk.old, gaugePk.old, routePk(-5).old, streamPk(-4).old])
  return rows.filter(
    (row) =>
      partitions.has(row.pk?.S ?? "") ||
      (row.pk?.S === noteKeys.old.pk && row.sk?.S === noteKeys.old.sk) ||
      [-1001, -3003].some((serial) => row.pk?.S === sentinelKeys(serial).old.pk),
  )
})

const run = (options?: Table.RekeyOptions) =>
  Effect.gen(function* () {
    const db = yield* makeDb
    return yield* db.tables.MainTable.rekey({ streams: [Ledger, Accounts], ...options })
  })

type TransactInput = Parameters<DynamoClient["Service"]["transactWriteItems"]>[0]

/**
 * The client, running `before` (on the plain client) once, ahead of the
 * first transaction `when` picks: another writer's request landing between
 * a reader's read and its write.
 */
const racing = (
  when: (input: TransactInput) => boolean,
  before: Effect.Effect<unknown, unknown, DynamoClient | Table.TableConfig>,
) =>
  Layer.effect(
    DynamoClient,
    Effect.gen(function* () {
      const plain = yield* DynamoClient
      const table = yield* MainTable.Tag
      let armed = true
      return {
        ...plain,
        transactWriteItems: (input: TransactInput) =>
          Effect.gen(function* () {
            if (armed && when(input)) {
              armed = false
              yield* before.pipe(
                Effect.provideService(DynamoClient, plain),
                Effect.provideService(MainTable.Tag, table),
                Effect.orDie,
              )
            }
            return yield* plain.transactWriteItems(input)
          }),
      }
    }),
  )

/** Whether a transaction writes a row of the entity type `type`. */
const writes = (type: string) => (input: TransactInput) =>
  (input.TransactItems ?? []).some((item) => item.Put?.Item?.__edd_e__?.S === type)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeConnected("#171 rekey — connected", () => {
  it.effect(
    "dry run, run, rerun: every row kind moves once, conflicts and foreign rows are reported",
    () =>
      withTable(() =>
        Effect.gen(function* () {
          const seeded = yield* seed
          const before = yield* scanAll

          // Dry run: the counts, and nothing written.
          const dry = yield* run({ dryRun: true })
          expect(dry.moved).toEqual(seeded.moved)
          expect(dry.indexKeysRewritten).toBe(1)
          expect(dry.sentinelsMoved).toBe(2)
          const reasons = (report: Table.RekeyReport) =>
            report.conflicts.map((c) => [c.member, c.kind, c.reason]).sort()
          expect(reasons(dry)).toEqual([
            ["Meter", "item", "bothKeys"],
            ["RouteItem", "aggregate", "bothKeys"],
          ])
          expect(dry.skipped).toEqual({
            notLibrary: 1,
            unregistered: 1,
            unrecognizedKey: 0,
            rootNotSeen: 0,
          })
          expect(dry.scanned).toBe(before.length)
          expect(dry.capacity.requests).toBeGreaterThan(0)
          expect(yield* scanAll).toEqual(before)

          // The run, in parallel segments: the same counts.
          const report = yield* run({ segments: 3 })
          expect(report.moved).toEqual(seeded.moved)
          expect(report.indexKeysRewritten).toBe(1)
          expect(report.sentinelsMoved).toBe(2)
          expect(reasons(report)).toEqual(reasons(dry))
          expect(report.conflicts.find((c) => c.member === "Meter")?.key).toEqual(
            primaryOf(seeded.m11.old),
          )
          expect(report.resume).toEqual(Option.none())
          expect(yield* leftUnder136).toEqual([])
          // The conflicts are left as they were: both rows, until the owner
          // resolves them — here, by deleting the stale 1.36 copies.
          expect(yield* getRaw(primaryOf(seeded.m11.old))).toBeDefined()
          expect(yield* getRaw(primaryOf(seeded.m11.current))).toBeDefined()
          expect(yield* getRaw(seeded.root6)).toBeDefined()
          yield* deleteRaw(primaryOf(seeded.m11.old))
          yield* deleteRaw(seeded.root6)

          // Moved and rewritten items carry their current index keys.
          for (const keys of [seeded.m7, seeded.m9]) {
            const row = (yield* getRaw(primaryOf(keys.current)))!
            for (const [field, text] of Object.entries(keys.current)) {
              expect(row[field]?.S, field).toBe(text)
            }
          }

          // The ops find every row where they look for it, through every GSI shape.
          const db = yield* makeDb
          const ids = (rows: ReadonlyArray<{ readonly meterId: number }>) =>
            rows.map((r) => r.meterId).sort((a, b) => a - b)
          expect(ids(yield* db.entities.Meters.byZone({ zone: "z" }).collect())).toEqual([
            -11, -7, 8, 9,
          ])
          expect(ids(yield* db.entities.Meters.byChannel({ site: "s" }).collect())).toEqual([
            -11, -7, 8, 9,
          ])
          expect(
            ids(
              yield* db.entities.Meters.byPlace({ region: "emea" })
                .where(({ country }, { eq }) => eq(country, "uk"))
                .collect(),
            ),
          ).toEqual([-11, -7, 8, 9])
          expect(ids(yield* db.entities.Meters.byShelf({ site: "s" }).collect())).toEqual([
            -11, -7, 8, 9,
          ])
          expect(
            ids(yield* db.entities.Meters.byStatus({ status: "active", label: "a b" }).collect()),
          ).toEqual([-11, -7, 9])
          expect(ids(yield* db.entities.Meters.byBinding({ deviceBinding: -9 }).collect())).toEqual(
            [-11, -7, 9],
          )
          const unique = yield* db.entities.Meters.put(meter(-12, -1001, true))
            .asEffect()
            .pipe(Effect.flip)
          expect(unique._tag).toBe("UniqueConstraintViolation")
          const note = yield* db.entities.Notes.get({ owner: "o", title: "new york" }).asEffect()
          expect(note.body).toBe("b")
          expect((yield* db.entities.Docs.versions({ docId: -5 }).collect()).length).toBe(
            seeded.moved.snapshot,
          )
          expect((yield* db.entities.Docs.deleted.get({ docId: -5 })).title).toBe("v2")
          const events = yield* db.entities.Gauges.history({ gaugeId: -6 }).collect()
          expect(events.map((e) => e.at)).toEqual([1, 2])
          const route = yield* db.aggregates.Routes.get({ id: -5 })
          expect(route.stops.map((s) => s.label).sort()).toEqual(["a b", "c"])
          const listed = yield* db.aggregates.Routes.list({ area: "north" })
          expect(listed.data.map((r) => r.id)).toEqual([-5])
          expect((yield* Ledger.read(ledger(-4))).map((e) => e.version)).toEqual([1, 2, 3])
          const resolved = yield* db.aggregates.Routes.get({ id: -6 })
          expect(resolved.stops.map((s) => s.label)).toEqual(["d"])

          // Rerun: nothing moves.
          const again = yield* run()
          expect(again.moved).toEqual({
            item: 0,
            snapshot: 0,
            tombstone: 0,
            outbox: 0,
            event: 0,
            aggregate: 0,
            stream: 0,
          })
          expect(again.indexKeysRewritten).toBe(0)
          expect(again.sentinelsMoved).toBe(0)
          expect(again.conflicts).toEqual([])
        }),
      ),
    60_000,
  )

  it.effect(
    "a run interrupted mid-scan resumes from the last token it delivered",
    () =>
      withTable(() =>
        Effect.gen(function* () {
          const seeded = yield* seed
          const tokens: Array<string> = []
          const interrupted = yield* run({
            pageSize: 4,
            onProgress: (progress) =>
              Effect.suspend(() => {
                if (Option.isSome(progress.resume)) tokens.push(progress.resume.value)
                return tokens.length === 3 ? Effect.die("interrupted") : Effect.void
              }),
          }).pipe(Effect.exit)
          expect(interrupted._tag).toBe("Failure")
          expect(yield* leftUnder136).not.toEqual([])
          const resumed = yield* run({ pageSize: 4, resume: tokens[2]! })
          expect(resumed.resume).toEqual(Option.none())
          expect(yield* leftUnder136).toEqual([])
          const again = yield* run()
          expect(Object.values(again.moved).every((n) => n === 0)).toBe(true)
          expect(yield* getRaw(primaryOf(seeded.m7.current))).toBeDefined()
          expect((yield* Ledger.read(ledger(-4))).map((e) => e.version)).toEqual([1, 2, 3])
        }),
      ),
    60_000,
  )

  // Live: the writer paces its appends on the real clock.
  it.live(
    "a writer appending while a stream moves overwrites nothing and loses nothing",
    () =>
      withTable(() =>
        Effect.gen(function* () {
          const seeded = 40
          const appends = 15
          yield* Ledger.append(
            ledger(-4),
            Array.from({ length: seeded }, (_, i) => new Deposited({ amount: i + 1 })),
            0,
          )
          yield* demotePartition(streamPk(-4).now, streamPk(-4).old)

          // The writer: read the head, append one event, again on a conflict.
          const appendOne = (n: number) =>
            Effect.gen(function* () {
              const version = yield* Ledger.currentVersion(ledger(-4))
              yield* Ledger.append(ledger(-4), [new Deposited({ amount: 1000 + n })], version)
            }).pipe(Effect.retry({ times: 50 }), Effect.tap(Effect.sleep("15 millis")))
          const writer = Effect.forEach(
            Array.from({ length: appends }, (_, n) => n),
            appendOne,
            {
              discard: true,
            },
          )
          const [, report] = yield* Effect.all([writer, run({ pageSize: 10 })], {
            concurrency: "unbounded",
          })
          // The writer finds only what is at the current key, so it lands on a copy or beside the
          // rows. `rekey` copies only where nothing is and reports the rest.
          for (const conflict of [...report.conflicts, ...(yield* run()).conflicts]) {
            expect(["contended", "bothKeys"]).toContain(conflict.reason)
          }
          const rows = [
            ...(yield* partition(streamPk(-4).old)),
            ...(yield* partition(streamPk(-4).now)),
          ]
          const amounts = new Set(rows.map((row) => Number(row.data?.M?.amount?.N)))
          for (let i = 1; i <= seeded; i++) expect(amounts.has(i), String(i)).toBe(true)
          for (let n = 0; n < appends; n++) expect(amounts.has(1000 + n), String(n)).toBe(true)
        }),
      ),
    60_000,
  )

  it.effect(
    "an event appended once a stream is copied, before the flip, moves with it",
    () =>
      withTable(() =>
        Effect.gen(function* () {
          yield* Ledger.append(
            ledger(-4),
            [1, 2, 3].map((amount) => new Deposited({ amount })),
            0,
          )
          yield* demotePartition(streamPk(-4).now, streamPk(-4).old)
          const flip = (input: TransactInput) =>
            (input.TransactItems ?? []).some(
              (item) => item.Update?.UpdateExpression === "SET #moved = :to",
            )
          const report = yield* run().pipe(
            Effect.provide(
              racing(flip, Ledger.append(ledger(-4), [new Deposited({ amount: 4 })], 3)),
            ),
          )
          expect(report.conflicts).toEqual([])
          expect(report.moved.stream).toBe(3)
          expect(yield* partition(streamPk(-4).old)).toEqual([])
          expect((yield* Ledger.read(ledger(-4))).map((event) => event.data.amount)).toEqual([
            1, 2, 3, 4,
          ])
        }),
      ),
    60_000,
  )

  it.effect(
    "a stream written beside its old rows is reported, and both are left as they are",
    () =>
      withTable(() =>
        Effect.gen(function* () {
          yield* Ledger.append(
            ledger(-4),
            [1, 2, 3].map((amount) => new Deposited({ amount })),
            0,
          )
          yield* demotePartition(streamPk(-4).now, streamPk(-4).old)
          // No read finds the old rows, so this append is version 1 at the current key.
          yield* Ledger.append(ledger(-4), [new Deposited({ amount: 9 })], 0)
          const dry = yield* run({ dryRun: true })
          const report = yield* run()
          expect(report.conflicts.map((c) => c.reason)).toEqual(["bothKeys"])
          expect(dry.conflicts).toEqual(report.conflicts)
          expect(report.moved.stream).toBe(0)
          expect(yield* partition(streamPk(-4).old)).toHaveLength(3)
          expect((yield* Ledger.read(ledger(-4))).map((event) => event.data.amount)).toEqual([9])
        }),
      ),
    60_000,
  )

  it.effect(
    "a soft-deleted item's kept reservations move to, and name, its current key",
    () =>
      withTable(() =>
        Effect.gen(function* () {
          const db = yield* makeDb
          yield* db.entities.Badges.put({ owner: "o", tag: "plain", code: -77 }).asEffect()
          yield* db.entities.Badges.delete({ owner: "o", tag: "plain" }).asEffect()
          yield* db.entities.Cards.put({ cardId: -3, name: "plain" }).asEffect()
          yield* db.entities.Cards.delete({ cardId: -3 }).asEffect()
          // As 1.36 left them: the badge's code reservation under its 1.36
          // key; the card's tombstone under its 1.36 partition, its name
          // reservation (whose key text is unchanged) naming its 1.36 key.
          const code = uniqueKeys("Badge", "code", -77)
          expect(code.old).not.toEqual(code.current)
          const held = (yield* getRaw(code.current))!
          yield* rewrite(held, { ...held, ...toAttributeMap(code.old) })
          yield* demotePartition(cardPk.now, cardPk.old)
          const name = uniqueKeys("Card", "name", "plain")
          expect(name.old).toEqual(name.current)
          yield* putRaw({ ...(yield* getRaw(name.current))!, _entity_pk: { S: cardPk.old } })

          const report = yield* run()
          expect(report.sentinelsMoved).toBe(2)
          expect(report.moved.tombstone).toBe(1)
          expect(report.conflicts).toEqual([])
          expect(yield* getRaw(code.old)).toBeUndefined()
          expect((yield* getRaw(name.current))?._entity_pk?.S).toBe(cardPk.now)

          // The values are still taken, and both restore.
          const badgeTaken = yield* db.entities.Badges.put({ owner: "p", tag: "x", code: -77 })
            .asEffect()
            .pipe(Effect.flip)
          const cardTaken = yield* db.entities.Cards.put({ cardId: 4, name: "plain" })
            .asEffect()
            .pipe(Effect.flip)
          expect(badgeTaken._tag).toBe("UniqueConstraintViolation")
          expect(cardTaken._tag).toBe("UniqueConstraintViolation")
          const badge = yield* db.entities.Badges.restore({ owner: "o", tag: "plain" })
          const card = yield* db.entities.Cards.restore({ cardId: -3 })
          expect(badge.code).toBe(-77)
          expect(card.name).toBe("plain")

          const again = yield* run()
          expect(again.sentinelsMoved).toBe(0)
          expect(again.conflicts).toEqual([])
        }),
      ),
    60_000,
  )

  // Nothing is promised to a write that lands before the move is done: the root moves last, so it
  // finds the edges moved so far and no root. What these pin is that nothing is overwritten and the
  // run ends with the move done.
  it.effect(
    "an aggregate update landing while rekey moves the aggregate finds no root and writes nothing",
    () =>
      withTable(() =>
        Effect.gen(function* () {
          yield* seedRoute
          let error: { readonly _tag: string } | undefined
          const update = Effect.gen(function* () {
            const db = yield* makeDb
            error = yield* db.aggregates.Routes.update({ id: -5 }, ({ current }) => current).pipe(
              Effect.flip,
            )
          })
          const report = yield* run().pipe(Effect.provide(racing(writes("RouteItem"), update)))
          expect(error?._tag).toBe("AggregateAssemblyError")
          expect(report.conflicts).toEqual([])
          expect(report.moved.aggregate).toBe(3)
          expect(yield* partition(routePk(-5).old)).toEqual([])
          const db = yield* makeDb
          const route = yield* db.aggregates.Routes.get({ id: -5 })
          expect(route.stops.map((s) => [s.label, s.note]).sort()).toEqual([
            ["a b", "1"],
            ["c", "2"],
          ])
          expect(
            (yield* db.aggregates.Routes.list({ area: "north" })).data.map((r) => r.id),
          ).toEqual([-5])
        }),
      ),
    60_000,
  )

  it.effect(
    "an aggregate delete landing while rekey moves the aggregate deletes what is at its current key",
    () =>
      withTable(() =>
        Effect.gen(function* () {
          yield* seedRoute
          const remove = Effect.gen(function* () {
            const db = yield* makeDb
            yield* db.aggregates.Routes.delete({ id: -5 })
          })
          const report = yield* run().pipe(Effect.provide(racing(writes("RouteItem"), remove)))
          expect(report.conflicts).toEqual([])
          expect(yield* partition(routePk(-5).old)).toEqual([])
          // The edges had moved and are gone; the root was still on its way.
          expect((yield* partition(routePk(-5).now)).map((row) => row.__edd_e__?.S)).toEqual([
            "RouteItem",
          ])
        }),
      ),
    60_000,
  )

  it.effect(
    "an aggregate whose edge keys alias moves along the chain",
    () =>
      withTable(() =>
        Effect.gen(function* () {
          // "a b" is under "a%20b" now; "a%20b" was under "a%20b" in 1.36 and
          // is under "a%2520b" now: one edge's current key is the other's
          // 1.36 key, in a partition whose key text did not change.
          const db = yield* makeDb
          const labels = ["a b", "a%20b"]
          yield* db.aggregates.Trails.create({
            name: "t",
            stops: labels.map((label, i) => Stop.make({ label, note: String(i) })),
          })
          expect(trailStopSk("a b")).toBe(trailStopSk136("a%20b"))
          for (const label of labels) {
            const row = (yield* scanAll).find((r) => r.sk?.S === trailStopSk(label))!
            yield* rewrite(row, { ...row, sk: { S: trailStopSk136(label) } })
          }
          const pk = (yield* scanAll).find((r) => r.__edd_e__?.S === "TrailItem")!.pk!.S!

          const dry = yield* run({ dryRun: true })
          expect(dry.conflicts).toEqual([])
          expect(dry.moved.aggregate).toBe(2)
          const report = yield* run()
          expect(report.conflicts).toEqual([])
          expect(report.moved.aggregate).toBe(2)
          expect(
            (yield* partition(pk))
              .filter((row) => row.__edd_e__?.S === "TrailStop")
              .map((row) => [row.sk?.S, row.note?.S])
              .sort(),
          ).toEqual(labels.map((label, i) => [trailStopSk(label), String(i)]).sort())
          const trail = yield* db.aggregates.Trails.get({ name: "t" })
          expect(trail.stops.map((s) => [s.label, s.note]).sort()).toEqual([
            ["a b", "0"],
            ["a%20b", "1"],
          ])
          const again = yield* run()
          expect(again.moved.aggregate).toBe(0)
          expect(again.conflicts).toEqual([])
          // An update after the move finds both edges, and keeps them apart.
          yield* db.aggregates.Trails.update({ name: "t" }, ({ current }) =>
            Trail.make({
              ...current,
              stops: current.stops.map((stop) => Stop.make({ ...stop, note: `${stop.note}!` })),
            }),
          )
          expect(
            (yield* scanAll)
              .filter((row) => row.__edd_e__?.S === "TrailStop")
              .map((row) => [row.sk?.S, row.note?.S])
              .sort(),
          ).toEqual(labels.map((label, i) => [trailStopSk(label), `${i}!`]).sort())
        }),
      ),
    60_000,
  )

  it.effect(
    "retained items move with their snapshots, and every write finds them afterwards",
    () =>
      withTable(() =>
        Effect.gen(function* () {
          const db = yield* makeDb
          const key = (seq: number) => ({ deviceId: "dev-r", seq })
          const seeded = [
            ...(yield* Effect.forEach([-20, -21, -23, -24], (seq) => seedReading(seq, `l${-seq}`))),
            yield* seedReading(-40, "r", true),
          ]
          const report = yield* run()
          expect(report.conflicts).toEqual([])
          // Nothing left under a 1.36 key: the items moved, each with its snapshot.
          const rows = yield* partition(seeded[0]!.old.pk!)
          for (const { old, versions136 } of seeded) {
            expect(rows.filter((row) => row.sk!.S === old.sk)).toEqual([])
            expect(rows.filter((row) => row.sk!.S!.startsWith(versions136))).toEqual([])
          }
          yield* db.entities.Readings.put({ ...key(-20), label: "x2", serial: -2000 }).asEffect()
          yield* db.entities.Readings.delete(key(-21)).asEffect()
          yield* db.entities.Readings.update(key(-23)).set({ label: "u2" }).asEffect()
          yield* db.entities.Readings.upsert({ ...key(-24), label: "s2", serial: -2400 }).asEffect()
          yield* db.entities.Readings.restore(key(-40))
          for (const [seq, label] of [
            [-20, "l20"],
            [-21, "l21"],
            [-23, "l23"],
            [-24, "l24"],
            [-40, "r"],
          ] as const) {
            const versions = yield* db.entities.Readings.versions(key(seq)).collect()
            expect(
              versions.map((r) => [versionOf(r), r.label]),
              String(seq),
            ).toEqual([[1, label]])
          }
          const dry = yield* run({ dryRun: true })
          expect(dry.conflicts).toEqual([])
          expect(dry.moved).toEqual({
            item: 0,
            snapshot: 0,
            tombstone: 0,
            outbox: 0,
            event: 0,
            aggregate: 0,
            stream: 0,
          })
          expect(dry.sentinelsMoved).toBe(0)
        }),
      ),
    60_000,
  )

  it.effect(
    "a stream id of several composites, a string one holding '#', moves",
    () =>
      withTable(() =>
        Effect.gen(function* () {
          const id = { tenant: "a#b", n: -3 } as unknown as {
            readonly tenant: string
            readonly n: string
          }
          yield* Accounts.append(
            id,
            [new Deposited({ amount: 1 }), new Deposited({ amount: 2 })],
            0,
          )
          const pk = {
            now: DynamoSchema.composeKey(AppSchema, "Accounts", [
              "a%23b",
              KeyComposer.serializeValue(-3),
            ]),
            old: DynamoSchema.composeKey(AppSchema, "Accounts", [
              "a#b",
              KeyComposer.serializeValue136(-3),
            ]),
          }
          yield* demotePartition(pk.now, pk.old)
          const report = yield* run()
          expect(report.moved.stream).toBe(2)
          expect(report.skipped.unrecognizedKey).toBe(0)
          expect(report.conflicts).toEqual([])
          expect(yield* partition(pk.old)).toEqual([])
          expect((yield* Accounts.read(id)).map((e) => e.data.amount)).toEqual([1, 2])
        }),
      ),
    60_000,
  )
})
