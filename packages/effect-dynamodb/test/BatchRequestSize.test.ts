/**
 * The library splits its own requests by every limit DynamoDB applies to one, the 16 MB request
 * body included: `Batch.write`'s `BatchWriteItem` requests and its versioned puts' transactions.
 * 25 items within 400 KB can be over 16 MB as the JSON sent (a control character is 6 bytes there
 * and 1 in the item), which DynamoDB refuses. A caller's own atomic request can't be split: one
 * over 16 MB is sent, refused, and named.
 *
 * Every table here refuses a body over 16 MiB as DynamoDB Local does (HTTP 413), measuring it with
 * native `JSON.stringify` — not the library's measure. A batch within every limit is sent exactly
 * as before, split by its count alone.
 */

import type { TransactWriteItem, WriteRequest } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { type DynamoError, ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { Effect, Exit, Layer, Schema } from "effect"
import * as Aggregate from "../src/Aggregate.js"
import * as Batch from "../src/Batch.js"
import * as ConsumedCapacity from "../src/ConsumedCapacity.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { itemBytes, REQUEST_MAX_BYTES, transactionBytes } from "../src/internal/ItemSize.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { mockDynamoClientLayer } from "./helpers/MockDynamoClient.js"
import { makeRecordingTable, sdkBodyBytes, tooLargeFailure } from "./helpers/RecordingTable.js"

const schema = DynamoSchema.make({ name: "wire", version: 1 })

class Note extends Schema.Class<Note>("Note")({ noteId: Schema.String, body: Schema.String }) {}

const Notes = Entity.make({
  model: Note,
  entityType: "Note",
  primaryKey: { pk: { field: "pk", composite: ["noteId"] }, sk: { field: "sk", composite: [] } },
})

const VersionedNotes = Entity.make({
  model: Note,
  entityType: "VersionedNote",
  primaryKey: { pk: { field: "pk", composite: ["noteId"] }, sk: { field: "sk", composite: [] } },
  versioned: true,
})

const OtherNotes = Entity.make({
  model: Note,
  entityType: "OtherNote",
  primaryKey: { pk: { field: "pk", composite: ["noteId"] }, sk: { field: "sk", composite: [] } },
})

const UniqueNotes = Entity.make({
  model: Note,
  entityType: "UniqueNote",
  primaryKey: { pk: { field: "pk", composite: ["noteId"] }, sk: { field: "sk", composite: [] } },
  unique: { body: ["body"] },
})

const MainTable = Table.make({ schema, entities: { Notes, VersionedNotes, UniqueNotes } })
const OtherTable = Table.make({ schema, entities: { OtherNotes } })

/** A table that records every request and refuses a body over 16 MiB, as DynamoDB Local does. */
const strictTable = () => makeRecordingTable({ refuseBodiesOver: REQUEST_MAX_BYTES })

const on =
  (table: ReturnType<typeof strictTable>, capacity: Layer.Layer<never> = Layer.empty) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(Layer.mergeAll(table.layer, MainTable.layer({ name: "t" }), capacity)),
    ) as Effect.Effect<A, E>

const id = (i: number) => `n${String(i).padStart(3, "0")}`
const nul = (chars: number) => "\u0000".repeat(chars)

/** The bodies of the requests of `command` a table was sent, as the SDK would send them. */
const bodies = (table: ReturnType<typeof strictTable>, command: string) =>
  table.requests
    .filter((request) => request.command === command)
    .map((request) => sdkBodyBytes(command, request.input))

const CAPACITY = [
  ["capacity reporting off", Layer.empty],
  ["capacity reporting on", ConsumedCapacity.layer()],
  ["capacity reporting on, by index", ConsumedCapacity.layer({ level: "indexes" })],
] as const

describe("Batch.write splits its requests at 16 MB of body", () => {
  it.effect("25 plain puts over 16 MB as JSON go in requests DynamoDB accepts", () =>
    Effect.gen(function* () {
      const table = strictTable()
      // 115,000 NULs: 115 KB of item, 690 KB of JSON. 25 of them are 17.25 MB as one request.
      const puts = Array.from({ length: 25 }, (_, i) =>
        Notes.put({ noteId: id(i), body: nul(115_000) }),
      )
      yield* Batch.write(puts).pipe(on(table))
      const sent = bodies(table, "BatchWriteItem")
      expect(sent.length).toBe(2)
      for (const body of sent) expect(body).toBeLessThanOrEqual(REQUEST_MAX_BYTES)
      // The first took every put that fit.
      expect(sent[0]! + 690_000).toBeGreaterThan(REQUEST_MAX_BYTES)
      expect(table.items.size).toBe(25)
      for (const item of table.items.values()) expect(itemBytes(item)).toBeLessThan(409_600)
    }),
  )

  it.effect(
    "versioned puts within 4 MB of item size but over 16 MB as JSON: transactions DynamoDB accepts",
    () =>
      Effect.gen(function* () {
        const table = strictTable()
        const puts = Array.from({ length: 10 }, (_, i) =>
          VersionedNotes.put({ noteId: id(i), body: nul(280_000) }),
        )
        yield* Batch.write(puts).pipe(on(table))
        const sent = table.requests.filter((request) => request.command === "TransactWriteItems")
        expect(sent.map((request) => request.input.TransactItems.length)).toEqual([9, 1])
        for (const request of sent) {
          expect(sdkBodyBytes(request.command, request.input)).toBeLessThanOrEqual(
            REQUEST_MAX_BYTES,
          )
        }
        // By item size alone, all ten fit one transaction.
        expect(
          transactionBytes(sent.flatMap((request) => request.input.TransactItems)),
        ).toBeLessThan(4_194_304)
        expect(table.items.size).toBe(10)
      }),
  )

  describe.each(CAPACITY)("at the boundary, %s", (_label, capacity) => {
    /**
     * 25 writes whose one request would be exactly `REQUEST_MAX_BYTES + extra` bytes as sent:
     * NULs (6 bytes each) bring it close, ASCII (1 byte each) the rest. Measured from a request
     * actually sent, by the tests' own measure.
     */
    const plainAt = (extra: number) =>
      Effect.gen(function* () {
        const probe = strictTable()
        const probePuts = (chars: number, pad: number) =>
          Array.from({ length: 25 }, (_, i) =>
            Notes.put({ noteId: id(i), body: nul(chars) + (i === 0 ? "a".repeat(pad) : "") }),
          )
        yield* Batch.write(probePuts(0, 0)).pipe(on(probe, capacity))
        const empty = bodies(probe, "BatchWriteItem")[0]!
        const chars = Math.floor((REQUEST_MAX_BYTES - empty) / (6 * 25))
        const pad = REQUEST_MAX_BYTES - empty - 6 * 25 * chars + extra
        const table = strictTable()
        yield* Batch.write(probePuts(chars, pad)).pipe(on(table, capacity))
        return { table, sent: bodies(table, "BatchWriteItem") }
      })

    it.effect("a BatchWriteItem of exactly 16,777,216 bytes is sent whole", () =>
      Effect.gen(function* () {
        const { table, sent } = yield* plainAt(0)
        expect(sent).toEqual([REQUEST_MAX_BYTES])
        expect(table.items.size).toBe(25)
      }),
    )

    it.effect("one byte more is split in two", () =>
      Effect.gen(function* () {
        const { table, sent } = yield* plainAt(1)
        expect(sent.length).toBe(2)
        for (const body of sent) expect(body).toBeLessThanOrEqual(REQUEST_MAX_BYTES)
        expect(table.items.size).toBe(25)
      }),
    )

    const versionedAt = (extra: number) =>
      Effect.gen(function* () {
        const probePuts = (chars: number, pad: number) =>
          Array.from({ length: 10 }, (_, i) =>
            VersionedNotes.put({
              noteId: id(i),
              body: nul(chars) + (i === 0 ? "a".repeat(pad) : ""),
            }),
          )
        const probe = strictTable()
        yield* Batch.write(probePuts(0, 0)).pipe(on(probe, capacity))
        const empty = bodies(probe, "TransactWriteItems")[0]!
        const chars = Math.floor((REQUEST_MAX_BYTES - empty) / (6 * 10))
        const pad = REQUEST_MAX_BYTES - empty - 6 * 10 * chars + extra
        const table = strictTable()
        yield* Batch.write(probePuts(chars, pad)).pipe(on(table, capacity))
        return { table, sent: bodies(table, "TransactWriteItems") }
      })

    it.effect("a versioned transaction of exactly 16,777,216 bytes is sent whole", () =>
      Effect.gen(function* () {
        const { table, sent } = yield* versionedAt(0)
        expect(sent).toEqual([REQUEST_MAX_BYTES])
        expect(table.items.size).toBe(10)
      }),
    )

    it.effect("one byte more is two transactions", () =>
      Effect.gen(function* () {
        const { table, sent } = yield* versionedAt(1)
        expect(sent.length).toBe(2)
        for (const body of sent) expect(body).toBeLessThanOrEqual(REQUEST_MAX_BYTES)
        expect(table.items.size).toBe(10)
      }),
    )
  })

  describe.each(CAPACITY)("a batch within every limit, %s", (_label, capacity) => {
    it.effect("is sent exactly as by count alone: 25 requests, then 100 actions", () =>
      Effect.gen(function* () {
        const table = strictTable()
        const twoTables = Layer.mergeAll(OtherTable.layer({ name: "u" }))
        // Plain puts and deletes on two tables, interleaved, and versioned puts.
        const plain = Array.from({ length: 63 }, (_, i) =>
          i % 4 === 3
            ? Notes.delete({ noteId: id(i) })
            : i % 3 === 0
              ? OtherNotes.put({ noteId: id(i), body: "other" })
              : Notes.put({ noteId: id(i), body: i % 2 === 0 ? nul(10) : '"quoted"' }),
        )
        const versioned = Array.from({ length: 160 }, (_, i) =>
          VersionedNotes.put({ noteId: id(500 + i), body: "v" }),
        )
        yield* Batch.write([...plain, ...versioned]).pipe(
          on(table, Layer.merge(capacity, twoTables)),
        )
        const sent = table.take()
        // Versioned puts first, by 100.
        const transactions = sent.filter((request) => request.command === "TransactWriteItems")
        expect(transactions.map((request) => request.input.TransactItems.length)).toEqual([100, 60])
        const order = (action: TransactWriteItem) => action.Put!.Item!.pk!.S!
        expect(
          transactions.flatMap((request) =>
            request.input.TransactItems.map((action: TransactWriteItem) => order(action)),
          ),
        ).toEqual(versioned.map((_, i) => `$wire#v1#versionednote#noteid_${id(500 + i)}`))
        // Then the plain ones: by 25, in order, each request grouping its writes by table.
        const batches = sent.filter((request) => request.command === "BatchWriteItem")
        const writes = batches.flatMap((request) =>
          Object.entries(request.input.RequestItems as Record<string, Array<WriteRequest>>).flatMap(
            ([tableName, requests]) => requests.map((write) => ({ tableName, write })),
          ),
        )
        // In the batch's order: by the note id ending each key.
        const idOf = ({ write }: { write: WriteRequest }) =>
          (write.PutRequest?.Item ?? write.DeleteRequest?.Key)!.pk!.S!.slice(-4)
        writes.sort((a, b) => (idOf(a) < idOf(b) ? -1 : 1))
        expect(new Set(writes.map(({ tableName }) => tableName))).toEqual(new Set(["t", "u"]))
        const expected = []
        for (let i = 0; i < writes.length; i += 25) {
          const RequestItems: Record<string, Array<WriteRequest>> = {}
          for (const { tableName, write } of writes.slice(i, i + 25)) {
            RequestItems[tableName] = [...(RequestItems[tableName] ?? []), write]
          }
          expected.push(RequestItems)
        }
        expect(batches.map((request) => request.input.RequestItems)).toEqual(expected)
        expect(batches.map((request) => request.input.RequestItems).length).toBe(3)
        // Nothing else rides on the request but what the client always added.
        for (const request of sent) {
          expect(Object.keys(request.input).sort()).toEqual(
            capacity === Layer.empty
              ? [request.command === "BatchWriteItem" ? "RequestItems" : "TransactItems"]
              : [
                  "ReturnConsumedCapacity",
                  request.command === "BatchWriteItem" ? "RequestItems" : "TransactItems",
                ].sort(),
          )
        }
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// A caller's own atomic request: never split, named when DynamoDB refuses it
// ---------------------------------------------------------------------------

class Line extends Schema.Class<Line>("Line")({ lid: Schema.String, note: Schema.String }) {}

class Order extends Schema.Class<Order>("Order")({
  id: Schema.String,
  note: Schema.String,
  lines: Schema.Array(Line),
}) {}

const Orders = Aggregate.make(Order, {
  table: MainTable,
  schema,
  pk: { field: "pk", composite: ["id"] },
  collection: { name: "orders" },
  root: { entityType: "OrderItem" },
  edges: { lines: Aggregate.many({ entityType: "OrderLine", sk: { composite: ["lid"] } }) },
})

class Recorded extends Schema.TaggedClass<Recorded>()("Recorded", { note: Schema.String }) {}

const Ledger = EventStore.makeStream({
  table: MainTable,
  streamName: "Ledger",
  events: [Recorded],
  streamId: { composite: ["ledgerId"] },
})

/** The DynamoDB error a diagnosed `ValidationError` keeps: its cause's cause. */
const original = (error: ValidationError) => (error.cause as Error).cause

describe("a caller's own request over 16 MB is sent once and named", () => {
  it.effect("Transaction.transactWrite", () =>
    Effect.gen(function* () {
      const table = strictTable()
      const puts = Array.from({ length: 10 }, (_, i) =>
        Notes.put({ noteId: id(i), body: nul(280_000) }),
      )
      const error = yield* Transaction.transactWrite(puts).pipe(on(table), Effect.flip)
      expect(error).toBeInstanceOf(ValidationError)
      const message = String((error as ValidationError).cause)
      expect(message).toContain("transactWrite: DynamoDB rejected the transaction")
      expect(message).toContain("16777216 bytes (16 MB)")
      expect((original(error as ValidationError) as DynamoError).cause).toMatchObject({
        $metadata: { httpStatusCode: 413 },
      })
      expect(table.requests.filter((r) => r.command === "TransactWriteItems").length).toBe(1)
      expect(table.items.size).toBe(0)
    }),
  )

  it.effect("EventStore.append", () =>
    Effect.gen(function* () {
      const table = strictTable()
      const events = Array.from({ length: 10 }, () => new Recorded({ note: nul(280_000) }))
      const error = yield* Ledger.append({ ledgerId: "l1" }, events, 0).pipe(on(table), Effect.flip)
      expect(error).toBeInstanceOf(ValidationError)
      expect(String((error as ValidationError).cause)).toContain(
        "EventStore.append: DynamoDB rejected the transaction for exceeding its limit of 16777216",
      )
      expect(table.items.size).toBe(0)
    }),
  )

  it.effect("an aggregate's write", () =>
    Effect.gen(function* () {
      const table = strictTable()
      const error = yield* Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: {},
          aggregates: { Orders },
          tables: { MainTable },
        })
        const lines = Array.from(
          { length: 12 },
          (_, i) => new Line({ lid: `line${i}`, note: nul(250_000) }),
        )
        return yield* db.aggregates.Orders.create({ id: "o1", note: "root", lines }).pipe(
          Effect.flip,
        )
      }).pipe(on(table))
      expect(error).toBeInstanceOf(ValidationError)
      expect(String((error as ValidationError).cause)).toContain(
        "Aggregate.write(OrderItem): DynamoDB rejected the transaction for exceeding its limit of 16777216",
      )
      expect(table.items.size).toBe(0)
    }),
  )

  it.effect("a 413 for a request within the limit passes through unchanged", () =>
    Effect.gen(function* () {
      const refused = tooLargeFailure("TransactWriteItems")
      const error = yield* Transaction.transactWrite([
        Notes.put({ noteId: "a", body: "small" }),
      ]).pipe(
        Effect.provide(
          Layer.merge(
            mockDynamoClientLayer({ transactWriteItems: () => Effect.fail(refused) }),
            MainTable.layer({ name: "t" }),
          ),
        ),
        Effect.flip,
      )
      expect(error).toBe(refused)
    }),
  )
})

// ---------------------------------------------------------------------------
// The diagnosis measures the request as sent: `ReturnConsumedCapacity` included
// ---------------------------------------------------------------------------

type Needs = DynamoClient | Table.TableConfig

/** `count` strings, NULs (6 bytes each as sent) bringing them close and ASCII the rest. */
const filled = (count: number, chars: number, pad: number) =>
  Array.from({ length: count }, (_, i) => nul(chars) + (i === 0 ? "a".repeat(pad) : ""))

const CALLER_SITES: ReadonlyArray<
  readonly [
    label: string,
    command: string,
    message: string,
    count: number,
    write: (strings: ReadonlyArray<string>) => Effect.Effect<unknown, unknown, Needs>,
  ]
> = [
  [
    "Transaction.transactWrite",
    "TransactWriteItems",
    "transactWrite: DynamoDB rejected the transaction",
    10,
    (strings) =>
      Transaction.transactWrite(strings.map((body, i) => Notes.put({ noteId: id(i), body }))),
  ],
  [
    "EventStore.append",
    "TransactWriteItems",
    "EventStore.append: DynamoDB rejected the transaction",
    10,
    (strings) =>
      Ledger.append(
        { ledgerId: "l1" },
        strings.map((note) => new Recorded({ note })),
        0,
      ),
  ],
  [
    "an aggregate's write",
    "TransactWriteItems",
    "Aggregate.write(OrderItem): DynamoDB rejected the transaction",
    12,
    (strings) =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: {},
          aggregates: { Orders },
          tables: { MainTable },
        })
        return yield* db.aggregates.Orders.create({
          id: "o1",
          note: "root",
          lines: strings.map((note, i) => new Line({ lid: `line${i}`, note })),
        })
      }),
  ],
]

describe.each(
  CAPACITY,
)("a caller's request one byte over 16 MB as sent, %s", (_label, capacity) => {
  it.effect.each(CALLER_SITES)(
    "%s: named, at the size it was sent",
    ([, command, message, count, write]) =>
      Effect.gen(function* () {
        // The body as sent with no NULs, then the NULs and ASCII that bring it to 16,777,217.
        const probe = makeRecordingTable()
        yield* write(filled(count, 0, 0)).pipe(on(probe, capacity))
        const empty = sdkBodyBytes(
          command,
          probe.requests.find((r) => r.command === command)!.input,
        )
        const target = REQUEST_MAX_BYTES + 1
        const chars = Math.floor((target - empty) / (6 * count))
        const pad = target - empty - 6 * count * chars

        const table = strictTable()
        const error = yield* write(filled(count, chars, pad)).pipe(on(table, capacity), Effect.flip)
        const sent = table.requests.filter((r) => r.command === command)
        expect(sent.map((r) => sdkBodyBytes(command, r.input))).toEqual([target])
        expect(error).toBeInstanceOf(ValidationError)
        const explained = String((error as ValidationError).cause)
        expect(explained).toContain(message)
        expect(explained).toContain(`measures the body it sent at ${target} bytes`)
        expect(table.items.size).toBe(0)
      }),
  )
})

// ---------------------------------------------------------------------------
// measureAppend measures the request append sends, additional items included
// ---------------------------------------------------------------------------

describe.each(
  CAPACITY,
)("measureAppend's requestBytes is the request append sends, %s", (_label, capacity) => {
  const creates = (strings: ReadonlyArray<string>) =>
    strings.map((body, i) => Notes.create({ noteId: id(i), body }))

  // A lone event is sent as a `PutItem`, whose one item (400 KB at most) can't reach 16 MB as JSON.
  it.effect("a lone event: the PutItem, to the byte", () =>
    Effect.gen(function* () {
      const table = makeRecordingTable()
      const events = [new Recorded({ note: `${nul(60_000)}"\\é` })]
      const planned = yield* Ledger.measureAppend({ ledgerId: "l1" }, events, 0).pipe(
        on(table, capacity),
      )
      yield* Ledger.append({ ledgerId: "l1" }, events, 0).pipe(on(table, capacity))
      const sent = table.requests.filter((r) => r.command === "PutItem")
      expect(sent.map((r) => sdkBodyBytes("PutItem", r.input))).toEqual([planned.requestBytes])
    }),
  )

  describe.each([
    ["one event and ten creates", 1],
    ["no events and ten creates", 0],
  ] as const)("%s", (_shape, eventCount) => {
    /** The append planned at `REQUEST_MAX_BYTES + extra` bytes, then sent. */
    const plannedAt = (extra: number) =>
      Effect.gen(function* () {
        const events = Array.from({ length: eventCount }, () => new Recorded({ note: "e" }))
        const options = (chars: number, pad: number) => ({
          additionalItems: creates(filled(10, chars, pad)),
        })
        const probe = makeRecordingTable()
        const measure = (chars: number, pad: number) =>
          Ledger.measureAppend({ ledgerId: "l1" }, events, 0, options(chars, pad)).pipe(
            on(probe, capacity),
          )
        const empty = (yield* measure(0, 0)).requestBytes
        const target = REQUEST_MAX_BYTES + extra
        const chars = Math.floor((target - empty) / 60)
        const pad = target - empty - 60 * chars
        const planned = yield* measure(chars, pad)
        const table = strictTable()
        const exit = yield* Ledger.append({ ledgerId: "l1" }, events, 0, options(chars, pad)).pipe(
          on(table, capacity),
          Effect.exit,
        )
        const sent = table.requests
          .filter((r) => r.command === "TransactWriteItems")
          .map((r) => sdkBodyBytes("TransactWriteItems", r.input))
        return { planned, exit, sent, table }
      })

    it.effect("planned at exactly 16,777,216 bytes: sent at that size, and accepted", () =>
      Effect.gen(function* () {
        const { planned, exit, sent, table } = yield* plannedAt(0)
        expect(planned.requestBytes).toBe(REQUEST_MAX_BYTES)
        expect(sent).toEqual([REQUEST_MAX_BYTES])
        expect(Exit.isSuccess(exit)).toBe(true)
        expect(table.items.size).toBe(10 + eventCount)
      }),
    )

    it.effect("planned one byte over: sent at that size, and refused", () =>
      Effect.gen(function* () {
        const { planned, exit, sent, table } = yield* plannedAt(1)
        expect(planned.requestBytes).toBe(REQUEST_MAX_BYTES + 1)
        expect(sent).toEqual([REQUEST_MAX_BYTES + 1])
        expect(Exit.isFailure(exit)).toBe(true)
        expect(table.items.size).toBe(0)
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// measureAppend sends no request
// ---------------------------------------------------------------------------

describe("measureAppend sends no request", () => {
  const events = [new Recorded({ note: "e" })]

  for (const [label, entity] of [
    ["versioned", VersionedNotes],
    ["unique-constrained", UniqueNotes],
  ] as const) {
    it.effect(
      `an additional put of a ${label} entity, which append reads to build: refused, unread`,
      () =>
        Effect.gen(function* () {
          const table = strictTable()
          const reports: Array<unknown> = []
          const capacity = ConsumedCapacity.layer({
            onOperation: (report) => Effect.sync(() => void reports.push(report)),
          })
          const options = { additionalItems: [entity.put({ noteId: "n1", body: "b" })] }
          const error = yield* Ledger.measureAppend({ ledgerId: "l1" }, events, 0, options).pipe(
            on(table, capacity),
            Effect.flip,
          )
          expect(error).toBeInstanceOf(ValidationError)
          expect(error.operation).toBe("EventStore.measureAppend")
          expect(String(error.cause)).toContain('append would send GetItem on table "t"')
          expect(table.requests).toEqual([])
          expect(reports).toEqual([])
          // `append` is as it was: it reads the item, then writes.
          yield* Ledger.append({ ledgerId: "l1" }, events, 0, options).pipe(on(table))
          expect(table.requests.map((request) => request.command)).toEqual([
            "GetItem",
            "TransactWriteItems",
          ])
        }),
    )
  }

  it.effect("additional items built without a read are measured, and nothing is sent", () =>
    Effect.gen(function* () {
      const table = strictTable()
      const options = {
        additionalItems: [
          Notes.put({ noteId: "n1", body: "b" }),
          Notes.create({ noteId: "n2", body: "c" }),
          Notes.delete({ noteId: "n3" }),
        ],
      }
      const planned = yield* Ledger.measureAppend({ ledgerId: "l1" }, events, 0, options).pipe(
        on(table),
      )
      expect(table.requests).toEqual([])
      yield* Ledger.append({ ledgerId: "l1" }, events, 0, options).pipe(on(table))
      expect(bodies(table, "TransactWriteItems")).toEqual([planned.requestBytes])
    }),
  )
})
