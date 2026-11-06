/**
 * #171 projection read models still under their 1.36 keys — connected tests
 * against DynamoDB Local.
 *
 * A read-model row keyed by a number and a sort key value holding a space
 * changed key text in 1.37. Each test writes its rows with the projections,
 * then rewrites them as 1.36 wrote them — the row, its outbox items (naming
 * the row's 1.36 key, in their sparse index too) and its tombstone under the
 * 1.36 key text `KeyText136` composes, without the mark 1.37 gives a
 * tombstone or an outbox item — with the raw client, and checks that:
 *
 * - **The projections find and move them.** `projection` (an outbox, a
 *   removal, and a plain one written through the entity) and
 *   `multiProjection` fold onto the row 1.36 left, not from `initial`; the
 *   next write moves it, and a tombstone keeps recognising redeliveries.
 * - **Outboxes drain in one order.** `drain(key)` and `drainPending` deliver
 *   a row's effects under both keys by revision.
 * - **`rekey` moves them.** Rows, tombstones and outbox items — on the read
 *   model's table and on an outbox table of their own — move to the row's
 *   current key; a dry run counts them; a rerun moves nothing.
 *
 * `LegacyKeyProjections.test.ts` covers the requests, and two values whose
 * keys spell each other's, with a recording table;
 * `connected.legacy-rows-1.36.0.test.ts` covers those two values with rows
 * the published 1.36.0 wrote.
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
import { afterAll, beforeAll, describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { fromAttributeMap, toAttributeMap } from "../src/Marshaller.js"
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

const AppSchema = DynamoSchema.make({ name: "legacy-proj", version: 1 })
const suffix = Date.now()
const eventsTableName = `legacy-proj-events-${suffix}`
const readTableName = `legacy-proj-read-${suffix}`
const outboxTableName = `legacy-proj-outbox-${suffix}`

class Opened extends Schema.TaggedClass<Opened>()("Opened", {}) {}
class Added extends Schema.TaggedClass<Added>()("Added", { amount: Schema.Number }) {}
class Closed extends Schema.TaggedClass<Closed>()("Closed", {}) {}
type AccountEvent = Opened | Added | Closed

const Tally = Schema.Struct({
  shop: Schema.Number,
  name: Schema.String,
  total: Schema.Number,
  version: Schema.Number,
  rev: Schema.Number,
})
type Tally = typeof Tally.Type

const Sum = Schema.Struct({
  shop: Schema.Number,
  name: Schema.String,
  total: Schema.Number,
  checkpoints: Schema.Record(Schema.String, Schema.Number),
  rev: Schema.Number,
})
type Sum = typeof Sum.Type

const Notice = Schema.Struct({ account: Schema.String, total: Schema.Number })

/** The read-model row each account feeds: a number and a sort key value holding a space. */
const ROWS: Record<string, { readonly shop: number; readonly name: string }> = {
  a1: { shop: -5, name: "a b" },
  a2: { shop: 12.5, name: "c d" },
  r1: { shop: 7, name: "x y" },
  r2: { shop: -8, name: "z z" },
  r3: { shop: 9, name: "w w" },
}

const EventsTable = Table.make({ schema: AppSchema, entities: {} })
const Accounts = EventStore.makeStream({
  table: EventsTable,
  streamName: "Account",
  events: [Opened, Added, Closed],
  streamId: { composite: ["account"] },
})

const primaryKey = {
  pk: { field: "pk", composite: ["shop"] },
  sk: { field: "sk", composite: ["name"] },
} as const
const Tallies = Entity.make({ model: Tally, entityType: "Tally", primaryKey, timestamps: true })
const Totals = Entity.make({ model: Tally, entityType: "Total", primaryKey, timestamps: true })
const Sums = Entity.make({ model: Sum, entityType: "Sum", primaryKey })
const Ledgers = Entity.make({ model: Tally, entityType: "Ledger", primaryKey })
const ReadTable = Table.make({ schema: AppSchema, entities: { Tallies, Totals, Sums, Ledgers } })
const OutboxTable = Table.make({ schema: AppSchema, entities: {} })

const key = (id: { readonly account: string }) => ROWS[id.account]!
const initial = (id: { readonly account: string }): Tally => ({
  ...key(id),
  total: 0,
  version: 0,
  rev: 0,
})
const add = (state: Tally, event: EventStore.StreamEvent<AccountEvent>) =>
  event.data._tag === "Added" ? { ...state, total: state.total + event.data.amount } : state
const effects = (event: EventStore.StreamEvent<AccountEvent>, next: Tally | undefined) =>
  event.data._tag === "Added" ? [{ account: event.streamId, total: next?.total ?? -1 }] : []

// Removal and an outbox (with its sparse index): the projection writes the row's item itself.
const Notifying = EventStore.projection({
  stream: Accounts,
  readModel: Tallies,
  key,
  initial,
  evolve: (state, event) =>
    Effect.succeed(event.data._tag === "Closed" ? EventStore.removeRow : add(state, event)),
  checkpoint: "version",
  revision: "rev",
  removal: {},
  outbox: { schema: Notice, effects, index: { name: "outbox", pk: "obpk", sk: "obsk" } },
})
// Neither: the projection writes through the entity's `put` / `create`.
const Plain = EventStore.projection({
  stream: Accounts,
  readModel: Totals,
  key,
  initial,
  evolve: (state, event) => Effect.succeed(add(state, event)),
  checkpoint: "version",
  revision: "rev",
})
// An outbox on a table of its own.
const Remote = EventStore.projection({
  stream: Accounts,
  readModel: Ledgers,
  key,
  initial,
  evolve: (state, event) => Effect.succeed(add(state, event)),
  checkpoint: "version",
  revision: "rev",
  outbox: {
    schema: Notice,
    effects,
    table: OutboxTable,
    index: { name: "outbox", pk: "obpk", sk: "obsk" },
  },
})
const Multi = EventStore.multiProjection({
  readModel: Sums,
  initial: (k: { readonly shop: number; readonly name: string }): Sum => ({
    ...k,
    total: 0,
    checkpoints: {},
    rev: 0,
  }),
  sources: (source: EventStore.SourceBuilder<{ shop: number; name: string }, Sum>) => ({
    account: source(Accounts, {
      key: (id) => ROWS[id.account]!,
      evolve: (state, event) =>
        Effect.succeed(
          event.data._tag === "Added"
            ? { ...state, total: state.total + event.data.amount }
            : state,
        ),
    }),
  }),
  checkpoints: { field: "checkpoints" },
  revision: "rev",
})

const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})
const TestLayer = Layer.mergeAll(
  ClientLayer,
  EventsTable.layer({ name: eventsTableName }),
  ReadTable.layer({ name: readTableName }),
  OutboxTable.layer({ name: outboxTableName }),
)
const provide = Effect.provide(TestLayer)

const makeDb = DynamoClient.make({
  entities: { Tallies, Totals, Sums, Ledgers },
  tables: { ReadTable, OutboxTable },
})

// ---------------------------------------------------------------------------
// Rows as 1.36 wrote them
// ---------------------------------------------------------------------------

type Row = Record<string, AttributeValue>
type Keys = Record<string, string>

const ZERO = { item: 0, snapshot: 0, tombstone: 0, outbox: 0, event: 0, aggregate: 0, stream: 0 }

type ReadModel = typeof Tallies | typeof Totals | typeof Sums | typeof Ledgers

/** A read model's row key for `account` now, and as 1.36 composed it. */
const keysOf = (entity: ReadModel, account: string) => {
  const record = ROWS[account]!
  const primary = entity.indexes.primary
  const current = KeyComposer.composeIndexKeys(
    AppSchema,
    entity.entityType,
    1,
    primary,
    record,
  ) as Keys
  const old = KeyText136.composeIndexKeys(AppSchema, entity.entityType, 1, primary, record)
  expect(old).not.toEqual(current)
  return { current, old }
}

/** Every item of `tableName`, unmarshalled. */
const items = (tableName: string) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const out: Array<Record<string, unknown>> = []
    let start: Row | undefined
    do {
      const page = yield* client.scan({
        TableName: tableName,
        ConsistentRead: true,
        ...(start !== undefined && { ExclusiveStartKey: start }),
      })
      for (const item of page.Items ?? []) out.push(fromAttributeMap(item))
      start = page.LastEvaluatedKey
    } while (start !== undefined)
    return out
  })

/** The items under `pk` whose sort key is `sk` or one of its outbox items'. */
const rowAndItems = (tableName: string, keys: Keys) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const { Items = [] } = yield* client.query({
      TableName: tableName,
      KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
      ExpressionAttributeValues: { ":pk": { S: keys.pk! }, ":sk": { S: keys.sk! } },
      ConsistentRead: true,
    })
    return Items.filter((item) => {
      const sk = item.sk!.S!
      return sk === keys.sk || sk.startsWith(`${keys.sk}#outbox#`)
    })
  })

/**
 * Rewrite `entity`'s row for `account`, its tombstone and its outbox items
 * (in `outboxTable`), as 1.36 wrote them: under the row's 1.36 key, naming
 * it, without 1.37's mark.
 */
const demote = (entity: ReadModel, account: string, outboxTable = readTableName) =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const { current, old } = keysOf(entity, account)
    let rewritten = 0
    for (const tableName of new Set([readTableName, outboxTable])) {
      for (const { __edd_kt__: _, ...item } of yield* rowAndItems(tableName, current)) {
        const sk = item.sk!.S!
        const toSk = `${old.sk}${sk.slice(current.sk!.length)}`
        const next: Row = { ...item, ...toAttributeMap({ pk: old.pk, sk: toSk }) }
        if (sk !== current.sk) {
          Object.assign(
            next,
            toAttributeMap({ __edd_row_pk__: old.pk, __edd_row_sk__: old.sk }),
            item.obsk === undefined ? {} : toAttributeMap({ obsk: `${old.pk}#${toSk}` }),
          )
        }
        yield* client.deleteItem({ TableName: tableName, Key: { pk: item.pk!, sk: item.sk! } })
        yield* client.putItem({ TableName: tableName, Item: next })
        rewritten++
      }
    }
    expect(rewritten).toBeGreaterThan(0)
    return { current, old }
  })

/** Where `entity`'s rows of `type` (`""`, `#tombstone`, `#outbox`) are, by key. */
const placed = (tableName: string, type: string) =>
  Effect.map(items(tableName), (all) =>
    all
      .filter((item) => item.__edd_e__ === type)
      .map((item) => `${item.pk}|${item.sk}`)
      .sort(),
  )

const seed = (account: string, events: ReadonlyArray<AccountEvent>, expected: number) =>
  Effect.gen(function* () {
    yield* Accounts.append({ account }, events, expected)
    return yield* Accounts.read({ account })
  })

const collect = () => {
  const delivered: Array<string> = []
  const deliver = (effect: typeof Notice.Type) =>
    Effect.sync(() => void delivered.push(`${effect.account}:${effect.total}`))
  return { delivered, deliver }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeConnected("#171 projection rows still under their 1.36 keys — connected", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        const KeySchema = [
          { AttributeName: "pk", KeyType: "HASH" as const },
          { AttributeName: "sk", KeyType: "RANGE" as const },
        ]
        const AttributeDefinitions = [
          { AttributeName: "pk", AttributeType: "S" as const },
          { AttributeName: "sk", AttributeType: "S" as const },
        ]
        yield* client.createTable({
          TableName: eventsTableName,
          BillingMode: "PAY_PER_REQUEST",
          KeySchema,
          AttributeDefinitions,
        })
        for (const TableName of [readTableName, outboxTableName]) {
          yield* client.createTable({
            TableName,
            BillingMode: "PAY_PER_REQUEST",
            KeySchema,
            AttributeDefinitions: [
              ...AttributeDefinitions,
              { AttributeName: "obpk", AttributeType: "S" },
              { AttributeName: "obsk", AttributeType: "S" },
            ],
            GlobalSecondaryIndexes: [
              {
                IndexName: "outbox",
                KeySchema: [
                  { AttributeName: "obpk", KeyType: "HASH" },
                  { AttributeName: "obsk", KeyType: "RANGE" },
                ],
                Projection: { ProjectionType: "ALL" },
              },
            ],
          })
        }
      }).pipe(provide),
    )
  }, 60_000)

  afterAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DynamoClient
        for (const TableName of [eventsTableName, readTableName, outboxTableName]) {
          yield* client.deleteTable({ TableName })
        }
      }).pipe(
        provide,
        Effect.catch(() => Effect.void),
      ),
    )
  }, 30_000)

  it.effect("every projection folds onto the row 1.36 left, and its next write moves it", () =>
    Effect.gen(function* () {
      const opened = yield* seed("a1", [new Opened(), new Added({ amount: 2 })], 0)
      yield* Notifying.applyBatch(opened)
      yield* Plain.applyBatch(opened)
      yield* Multi.applyBatch(opened.map((event) => ({ stream: "account" as const, event })))
      const tally = yield* demote(Tallies, "a1")
      const total = yield* demote(Totals, "a1")
      const sum = yield* demote(Sums, "a1")

      const more = yield* seed("a1", [new Added({ amount: 3 })], 2)
      const notified = yield* Notifying.apply(more[2]!)
      expect(Option.getOrThrow(notified.state)).toMatchObject({ total: 5, version: 3, rev: 2 })
      const plain = yield* Plain.apply(more[2]!)
      expect(Option.getOrThrow(plain.state)).toMatchObject({ total: 5, version: 3, rev: 2 })
      const multi = yield* Multi.catchUp(ROWS.a1!)
      expect(Option.getOrThrow(multi.state)).toMatchObject({
        total: 5,
        checkpoints: { "account#a1": 3 },
        rev: 2,
      })
      // Each row moved: under its current key only.
      for (const [type, keys] of [
        ["Tally", tally],
        ["Total", total],
        ["Sum", sum],
      ] as const) {
        expect(yield* placed(readTableName, type)).toEqual([
          `${keys.current.pk}|${keys.current.sk}`,
        ])
      }
      // The first effect waits under the 1.36 key, the second under the current one.
      expect(yield* placed(readTableName, "Tally#outbox")).toEqual(
        [
          `${tally.old.pk}|${tally.old.sk}#outbox#000000000001#0000`,
          `${tally.current.pk}|${tally.current.sk}#outbox#000000000002#0000`,
        ].sort(),
      )
      const { delivered, deliver } = collect()
      const drained = yield* Notifying.drain(ROWS.a1!, deliver)
      expect(drained.delivered).toBe(2)
      expect(delivered).toEqual(["a1:2", "a1:5"])
      expect(yield* placed(readTableName, "Tally#outbox")).toEqual([])
    }).pipe(provide),
  )

  it.effect("a tombstone 1.36 left recognises a redelivery; a new event moves it", () =>
    Effect.gen(function* () {
      const events = yield* seed(
        "a2",
        [new Opened(), new Added({ amount: 2 }), new Closed(), new Added({ amount: 4 })],
        0,
      )
      // The row removed at version 3, its tombstone under its 1.36 key.
      yield* Notifying.applyBatch(events.slice(0, 3))
      yield* Notifying.drain(ROWS.a2!, () => Effect.void)
      const { current, old } = yield* demote(Tallies, "a2")
      expect(yield* placed(readTableName, "Tally#tombstone")).toEqual([`${old.pk}|${old.sk}`])
      const late = yield* Notifying.apply(events[1]!)
      expect(late.alreadyApplied.map((e) => e.version)).toEqual([2])
      expect(late.removed).toBe(true)
      // Started again from `initial`, one revision past the tombstone's.
      const next = yield* Notifying.apply(events[3]!)
      expect(Option.getOrThrow(next.state)).toMatchObject({ total: 4, version: 4, rev: 2 })
      expect(yield* placed(readTableName, "Tally#tombstone")).toEqual([])
      expect(yield* placed(readTableName, "Tally")).toContain(`${current.pk}|${current.sk}`)
      const { delivered, deliver } = collect()
      yield* Notifying.drain(ROWS.a2!, deliver)
      expect(delivered).toEqual(["a2:4"])
    }).pipe(provide),
  )

  it.effect(
    "rekey moves rows, tombstones and outbox items, on both tables; a rerun moves none",
    () =>
      Effect.gen(function* () {
        // r1: a row and two effects. r2: a tombstone and one effect. r3: a row,
        // and its effect on the outbox table.
        yield* Notifying.applyBatch(
          yield* seed("r1", [new Opened(), new Added({ amount: 2 }), new Added({ amount: 3 })], 0),
        )
        const r2 = yield* seed("r2", [new Opened(), new Added({ amount: 1 }), new Closed()], 0)
        yield* Notifying.applyBatch(r2)
        yield* Remote.applyBatch(yield* seed("r3", [new Opened(), new Added({ amount: 5 })], 0))
        const r1Keys = yield* demote(Tallies, "r1")
        const r2Keys = yield* demote(Tallies, "r2")
        const r3Keys = yield* demote(Ledgers, "r3", outboxTableName)

        const db = yield* makeDb
        const before = yield* items(readTableName)
        const plan = yield* db.tables.ReadTable.rekey({ dryRun: true })
        expect(plan.moved).toEqual({ ...ZERO, item: 2, tombstone: 1, outbox: 3 })
        expect(plan.conflicts).toEqual([])
        expect(yield* items(readTableName)).toEqual(before)

        const report = yield* db.tables.ReadTable.rekey()
        expect(report.moved).toEqual({ ...ZERO, item: 2, tombstone: 1, outbox: 3 })
        expect(report.byMember.Tally?.moved).toEqual({ ...ZERO, item: 1, tombstone: 1, outbox: 3 })
        expect(report.conflicts).toEqual([])
        const outboxReport = yield* db.tables.OutboxTable.rekey()
        expect(outboxReport.moved).toEqual({ ...ZERO, outbox: 1 })
        expect(outboxReport.byMember.Ledger?.moved).toEqual({ ...ZERO, outbox: 1 })

        const at = (keys: Keys, rest = "") => `${keys.pk}|${keys.sk}${rest}`
        expect(yield* placed(readTableName, "Tally")).toContain(at(r1Keys.current))
        expect(yield* placed(readTableName, "Tally#tombstone")).toEqual([at(r2Keys.current)])
        expect(yield* placed(readTableName, "Tally#outbox")).toEqual(
          [
            at(r1Keys.current, "#outbox#000000000001#0000"),
            at(r1Keys.current, "#outbox#000000000001#0001"),
            at(r2Keys.current, "#outbox#000000000001#0000"),
          ].sort(),
        )
        expect(yield* placed(outboxTableName, "Ledger#outbox")).toEqual([
          at(r3Keys.current, "#outbox#000000000001#0000"),
        ])
        // Each moved item is marked, and names its row's current key — in its index too.
        for (const item of (yield* items(readTableName)).filter(
          (i) => i.__edd_e__ === "Tally#outbox",
        )) {
          expect(item.__edd_kt__).toBe(1)
          expect(item.obsk).toBe(`${item.__edd_row_pk__}#${item.sk}`)
          expect(String(item.sk).startsWith(`${item.__edd_row_sk__}#outbox#`)).toBe(true)
        }

        const again = yield* db.tables.ReadTable.rekey()
        expect(again.moved).toEqual(ZERO)
        expect(again.conflicts).toEqual([])
        expect((yield* db.tables.OutboxTable.rekey()).moved).toEqual(ZERO)

        // The sweep finds every effect where it moved; the tombstone still recognises a redelivery.
        const { delivered, deliver } = collect()
        const swept = yield* Notifying.drainPending(deliver)
        expect(swept.delivered).toBe(3)
        expect(delivered.filter((d) => d.startsWith("r1:"))).toEqual(["r1:2", "r1:5"])
        expect(delivered.filter((d) => d.startsWith("r2:"))).toEqual(["r2:1"])
        const remote = collect()
        yield* Remote.drainPending(remote.deliver)
        expect(remote.delivered).toEqual(["r3:5"])
        const late = yield* Notifying.apply(r2[1]!)
        expect(late.alreadyApplied.map((e) => e.version)).toEqual([2])
      }).pipe(provide),
  )
})
