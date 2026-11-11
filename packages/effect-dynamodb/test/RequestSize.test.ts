/**
 * The request-body measure (`ItemSize.jsonBytes`) and the one packer the library splits its own
 * requests with (`ItemSize.packRequests`). DynamoDB refuses a request whose body — the JSON the AWS
 * SDK sends — is over 16 MB: on DynamoDB Local, 16,777,216 bytes is accepted and 16,777,217
 * refused (HTTP 413), for every operation. The measure is checked here against the body the SDK
 * itself builds, so a packer that keeps a request within it keeps the body within the limit.
 */

import {
  BatchWriteItemCommand,
  DynamoDBClient,
  PutItemCommand,
  type TransactWriteItem,
  TransactWriteItemsCommand,
  type WriteRequest,
} from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { TRANSACT_WRITE_ITEMS_LIMIT } from "@effect-dynamodb/schema/Errors.js"
import { Effect, Layer, Schema } from "effect"
import * as ConsumedCapacity from "../src/ConsumedCapacity.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as EventStore from "../src/EventStore.js"
import {
  BATCH_WRITE_REQUESTS_LIMIT,
  batchWriteBodyBytes,
  batchWriteShape,
  batchWriteUnit,
  jsonBytes,
  jsonStringBytes,
  packRequests,
  REQUEST_MAX_BYTES,
  type RequestUnit,
  TRANSACT_WRITE_MAX_BYTES,
  transactWriteBodyBytes,
  transactWriteShape,
  transactWriteUnit,
} from "../src/internal/ItemSize.js"
import * as Table from "../src/Table.js"
import { localServer } from "./helpers/LocalServer.js"
import { sdkBodyBytes } from "./helpers/RecordingTable.js"

/** The body the AWS SDK builds for a command, captured before anything is sent. */
const sdkBody = async (
  command: BatchWriteItemCommand | TransactWriteItemsCommand | PutItemCommand,
): Promise<number> => {
  const client = new DynamoDBClient({
    region: "us-east-1",
    endpoint: "http://127.0.0.1:1",
    credentials: { accessKeyId: "x", secretAccessKey: "x" },
    maxAttempts: 1,
  })
  let captured: unknown
  client.middlewareStack.add(
    (_next) => async (args) => {
      captured = (args.request as { body?: unknown }).body
      throw new Error("captured")
    },
    { step: "finalizeRequest", name: "captureBody", priority: "low" },
  )
  await client.send(command as never).catch(() => undefined)
  client.destroy()
  if (typeof captured === "string") return Buffer.byteLength(captured, "utf8")
  if (captured instanceof Uint8Array) return captured.byteLength
  throw new Error("no body captured")
}

/** Strings whose JSON escapes differ from their item size, and some that don't. */
const STRINGS = [
  "",
  "plain ascii",
  "\u0000",
  "\u0000".repeat(7),
  "\b\f\n\r\t",
  Array.from({ length: 32 }, (_, c) => String.fromCharCode(c)).join(""),
  '"\\',
  "\u007f\u0080߿ࠀ￿",
  "é".repeat(5),
  "😀 emoji",
  "  ",
  "\ud800",
  "a\udc00b",
  "􏿿",
  "x\ud83d",
  "/<>&'",
]

describe("the request body measure", () => {
  it("a string measures as JSON.stringify's UTF-8 bytes, escapes and surrogates included", () => {
    for (const text of STRINGS) {
      expect(jsonStringBytes(text), JSON.stringify(text)).toBe(
        Buffer.byteLength(JSON.stringify(text), "utf8"),
      )
    }
    // Every code unit, alone and between two others.
    for (let c = 0; c < 0x10000; c++) {
      const text = `a${String.fromCharCode(c)}b`
      expect(jsonStringBytes(text)).toBe(Buffer.byteLength(JSON.stringify(text), "utf8"))
    }
  })

  it("a BatchWriteItem body is the one the SDK builds: every attribute type, two tables", async () => {
    for (const text of STRINGS) {
      const input = {
        RequestItems: {
          [`table${text}`]: [
            {
              PutRequest: {
                Item: {
                  pk: { S: `k${text}` },
                  [`name${text}`]: { S: text },
                  n: { N: "-12.5e3" },
                  b: { B: new Uint8Array(text.length) },
                  bs: { BS: [new Uint8Array(0), new Uint8Array(1), new Uint8Array(2)] },
                  ns: { NS: ["1", "2"] },
                  ss: { SS: [text, "z"] },
                  l: { L: [{ NULL: true }, { BOOL: false }, { BOOL: true }, { S: text }] },
                  m: { M: { [text]: { M: {} }, e: { L: [] } } },
                },
              },
            },
          ],
          other: [{ DeleteRequest: { Key: { pk: { S: text } } } }, { PutRequest: { Item: {} } }],
        },
      }
      expect(batchWriteBodyBytes(input)).toBe(await sdkBody(new BatchWriteItemCommand(input)))
      for (const level of ["TOTAL", "INDEXES"] as const) {
        const flagged = { ...input, ReturnConsumedCapacity: level }
        expect(jsonBytes(flagged)).toBe(await sdkBody(new BatchWriteItemCommand(flagged)))
      }
    }
  })

  it("a TransactWriteItems body adds the ClientRequestToken the SDK fills in", async () => {
    const items: Array<TransactWriteItem> = [
      {
        Put: {
          TableName: "t",
          Item: { pk: { S: "\u0000\u0001" }, v: { S: '"' } },
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": "pk" },
        },
      },
      {
        Update: {
          TableName: "t",
          Key: { pk: { S: "a" } },
          UpdateExpression: "SET #a = :a",
          ConditionExpression: "attribute_exists(#a)",
          ExpressionAttributeNames: { "#a": "a" },
          ExpressionAttributeValues: { ":a": { S: "\u0000" } },
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        },
      },
      { Delete: { TableName: "t", Key: { pk: { S: "b" } } } },
      {
        ConditionCheck: {
          TableName: "t",
          Key: { pk: { S: "c" } },
          ConditionExpression: "attribute_exists(pk)",
        },
      },
    ]
    const input = { TransactItems: items }
    expect(transactWriteBodyBytes(input)).toBe(await sdkBody(new TransactWriteItemsCommand(input)))
    expect(transactWriteBodyBytes(input)).toBe(jsonBytes(input) + 60)
    const flagged = { ...input, ReturnConsumedCapacity: "INDEXES" as const }
    expect(transactWriteBodyBytes(flagged)).toBe(
      await sdkBody(new TransactWriteItemsCommand(flagged)),
    )
    // A token of the caller's own is measured as given.
    const tokened = { ...input, ClientRequestToken: "abc" }
    expect(transactWriteBodyBytes(tokened)).toBe(
      await sdkBody(new TransactWriteItemsCommand(tokened)),
    )
    // The tests' independent measure (native JSON.stringify) agrees.
    expect(sdkBodyBytes("TransactWriteItems", input)).toBe(transactWriteBodyBytes(input))
  })

  it("a PutItem body is its input's JSON", async () => {
    const input = {
      TableName: "t",
      Item: { pk: { S: "k" }, data: { S: "\u0000".repeat(10) }, bin: { B: new Uint8Array(5) } },
      ConditionExpression: "attribute_not_exists(#pk)",
      ExpressionAttributeNames: { "#pk": "pk" },
    }
    expect(jsonBytes(input)).toBe(await sdkBody(new PutItemCommand(input)))
  })

  it("a control character is 6 bytes on the wire and 1 in the item: 25 items under 400 KB pass 16 MB", () => {
    const item = (i: number) => ({
      PutRequest: { Item: { pk: { S: `k${i}` }, v: { S: "\u0000".repeat(115_000) } } },
    })
    const body = batchWriteBodyBytes({
      RequestItems: { t: Array.from({ length: 25 }, (_, i) => item(i)) },
    })
    expect(body).toBeGreaterThan(REQUEST_MAX_BYTES)
    expect(REQUEST_MAX_BYTES).toBe(16_777_216)
  })
})

// ---------------------------------------------------------------------------
// The packer
// ---------------------------------------------------------------------------

const put = (pk: string, text: string): WriteRequest => ({
  PutRequest: { Item: { pk: { S: pk }, v: { S: text } } },
})

type Write = { readonly table: string; readonly request: WriteRequest }

/** The `BatchWriteItem` input a packed request is sent as: its requests grouped by table, in order. */
const batchInput = (writes: ReadonlyArray<Write>) => {
  const RequestItems: Record<string, Array<WriteRequest>> = {}
  for (const write of writes) {
    RequestItems[write.table] = [...(RequestItems[write.table] ?? []), write.request]
  }
  return { RequestItems }
}

const packBatch = (writes: ReadonlyArray<Write>, fields = {}) =>
  packRequests(
    writes,
    (write) => batchWriteUnit(write.table, write.request),
    batchWriteShape(fields),
  )

/** The base's split: 25 requests to a request, by count alone. */
const byCount = <A>(units: ReadonlyArray<A>, count: number): Array<Array<A>> => {
  const chunks: Array<Array<A>> = []
  for (let i = 0; i < units.length; i += count) chunks.push(units.slice(i, i + count))
  return chunks
}

describe("packRequests", () => {
  it("a batch within every limit is split exactly as by count alone", () => {
    const writes: Array<Write> = Array.from({ length: 83 }, (_, i) => ({
      table: i % 3 === 0 ? "a" : i % 3 === 1 ? "b\u0000" : "c",
      request: i % 5 === 0 ? { DeleteRequest: { Key: { pk: { S: `k${i}` } } } } : put(`k${i}`, "v"),
    }))
    expect(packBatch(writes)).toEqual(byCount(writes, BATCH_WRITE_REQUESTS_LIMIT))
    expect(packBatch(writes, { ReturnConsumedCapacity: "INDEXES" })).toEqual(
      byCount(writes, BATCH_WRITE_REQUESTS_LIMIT),
    )
    const items = Array.from({ length: 230 }, (_, i) => [
      { Put: { TableName: "t", Item: { pk: { S: `k${i}` } } } } satisfies TransactWriteItem,
    ])
    expect(packRequests(items, transactWriteUnit, transactWriteShape({}))).toEqual(
      byCount(items, TRANSACT_WRITE_ITEMS_LIMIT),
    )
  })

  it("a request's measure is its body, exactly: shared table names, commas, request fields", () => {
    for (const fields of [{}, { ReturnConsumedCapacity: "TOTAL" as const }]) {
      const writes: Array<Write> = [
        { table: "a", request: put("1", "\u0000") },
        { table: "b\u0001", request: { DeleteRequest: { Key: { pk: { S: "2" } } } } },
        { table: "a", request: put("3", '"') },
        { table: "b\u0001", request: put("4", "é") },
      ]
      const shape = batchWriteShape(fields)
      const units = writes.map((write) => batchWriteUnit(write.table, write.request))
      let wire = shape.envelope
      const seen = new Set<string>()
      for (const unit of units) {
        if (!seen.has(unit.shared!.key)) wire += unit.shared!.wire
        seen.add(unit.shared!.key)
        wire += unit.wire
      }
      expect(wire).toBe(jsonBytes({ ...batchInput(writes), ...fields }))
      const actions = writes.map((write) => ({ Put: { TableName: write.table, Item: {} } }))
      const tshape = transactWriteShape(fields)
      expect(
        actions.reduce((sum, action) => sum + transactWriteUnit([action]).wire, tshape.envelope),
      ).toBe(transactWriteBodyBytes({ TransactItems: actions, ...fields }))
    }
  })

  it("splits where the body would pass 16,777,216 bytes, and not one byte sooner", () => {
    // 25 writes of a control-heavy value, the last padded so the one request is exactly the limit.
    const writes = (pad: number): Array<Write> =>
      Array.from({ length: 25 }, (_, i) => ({
        table: "t",
        request: put(`k${String(i).padStart(2, "0")}`, "\u0000".repeat(100_000)),
      })).map((write, i) =>
        i === 24
          ? { ...write, request: put("k24", `${"\u0000".repeat(100_000)}${"a".repeat(pad)}`) }
          : write,
      )
    const base = jsonBytes(batchInput(writes(0)))
    const exact = writes(REQUEST_MAX_BYTES - base)
    expect(jsonBytes(batchInput(exact))).toBe(REQUEST_MAX_BYTES)
    expect(packBatch(exact)).toEqual([exact])
    const over = writes(REQUEST_MAX_BYTES - base + 1)
    const split = packBatch(over)
    expect(split.map((request) => request.length)).toEqual([24, 1])
    for (const request of split) {
      expect(jsonBytes(batchInput(request))).toBeLessThanOrEqual(REQUEST_MAX_BYTES)
    }
    // The request-level field the client adds counts: what fit exactly no longer does.
    expect(packBatch(exact, { ReturnConsumedCapacity: "TOTAL" }).length).toBe(2)
  })

  it("a transaction is split by its count, its 4 MB of item size and its 16 MB of body", () => {
    const action = (i: number, text: string): TransactWriteItem => ({
      Put: { TableName: "t", Item: { pk: { S: `k${i}` }, v: { S: text } } },
    })
    const sizes = (requests: ReadonlyArray<ReadonlyArray<ReadonlyArray<TransactWriteItem>>>) =>
      requests.map((request) => request.length)
    const pack = (units: ReadonlyArray<ReadonlyArray<TransactWriteItem>>) =>
      packRequests(units, transactWriteUnit, transactWriteShape({}))
    // 4 MB of item size binds: 'x' is one byte either way.
    const plain = Array.from({ length: 12 }, (_, i) => [action(i, "x".repeat(380_000))])
    expect(sizes(pack(plain))).toEqual([11, 1])
    // 16 MB of body binds first: 2.8 MB of item size, 16.8 MB on the wire.
    const escaped = Array.from({ length: 10 }, (_, i) => [action(i, "\u0000".repeat(280_000))])
    expect(sizes(pack(escaped))).toEqual([9, 1])
    for (const request of pack(escaped)) {
      expect(transactWriteBodyBytes({ TransactItems: request.flat() })).toBeLessThanOrEqual(
        REQUEST_MAX_BYTES,
      )
    }
    // Units that must share a transaction (a rekey move's Put and Delete) are never split.
    const pairs = Array.from({ length: 12 }, (_, i) => [
      action(2 * i, "\u0000".repeat(250_000)),
      { Delete: { TableName: "t", Key: { pk: { S: `old${i}` } } } },
    ])
    expect(sizes(pack(pairs))).toEqual([11, 1])
    expect(pack(pairs).map((request) => request.flat().length)).toEqual([22, 2])
    expect(TRANSACT_WRITE_MAX_BYTES).toBe(4_194_304)
  })

  it("a unit over a limit on its own goes alone, never dropped or refused", () => {
    const unit = (wire: number): RequestUnit => ({ count: 1, bytes: 0, wire })
    const units = [unit(10), unit(REQUEST_MAX_BYTES + 5), unit(10)]
    expect(packRequests(units, (u) => u, { count: 25, envelope: 18 })).toEqual([
      [units[0]],
      [units[1]],
      [units[2]],
    ])
    expect(packRequests([], (u: RequestUnit) => u, { count: 25, envelope: 18 })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// EventStream.measureAppend's requestBytes: the body append sends
// ---------------------------------------------------------------------------

class Noted extends Schema.TaggedClass<Noted>()("Noted", { note: Schema.String }) {}

const StreamTable = Table.make({
  schema: DynamoSchema.make({ name: "wire", version: 1 }),
  entities: {},
})

const Notebook = EventStore.makeStream({
  table: StreamTable,
  streamName: "Notebook",
  events: [Noted],
  streamId: { composite: ["bookId"] },
})

const CAPACITY = [
  ["capacity reporting off", Layer.empty],
  ["capacity reporting on", ConsumedCapacity.layer()],
  ["capacity reporting on, by index", ConsumedCapacity.layer({ level: "indexes" })],
] as const

describe.each(CAPACITY)("measureAppend's requestBytes, %s", (_label, capacity) => {
  const cases = [
    ["a single event (sent as a PutItem)", "PutItem", ['\u0000"é😀'], 0],
    [
      "three events (a TransactWriteItems)",
      "TransactWriteItems",
      ["a", "\u0001".repeat(50), '"'],
      0,
    ],
    [
      "three events after version 3 (a contiguity check too)",
      "TransactWriteItems",
      ["x", "y", "z"],
      3,
    ],
  ] as const
  it.effect.each(cases)("%s: the body the SDK sends", ([_name, command, notes, expectedVersion]) =>
    Effect.gen(function* () {
      const server = yield* localServer()
      const events = notes.map((note) => new Noted({ note }))
      const measured = yield* Notebook.measureAppend({ bookId: "b 1" }, events, expectedVersion)
      yield* Notebook.append({ bookId: "b 1" }, events, expectedVersion).pipe(
        Effect.provide(
          DynamoClient.layer({
            region: "us-east-1",
            endpoint: server.endpoint,
            credentials: { accessKeyId: "x", secretAccessKey: "x" },
          }),
        ),
      )
      const sent = server.of(command)
      expect(sent.length).toBe(1)
      expect(measured.requestBytes).toBe(Buffer.byteLength(sent[0]!.body, "utf8"))
      expect(sent[0]!.body.includes("ReturnConsumedCapacity")).toBe(capacity !== Layer.empty)
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(StreamTable.layer({ name: "t" }), capacity))),
  )

  it.effect("an append that would send nothing measures 0", () =>
    Effect.gen(function* () {
      expect((yield* Notebook.measureAppend({ bookId: "b" }, [], 0)).requestBytes).toBe(0)
    }).pipe(Effect.provide(Layer.merge(StreamTable.layer({ name: "t" }), capacity))),
  )
})
