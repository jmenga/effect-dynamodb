/**
 * A stream's `Schema.BigInt` against DynamoDB Local. The marshaller stores one as `N` and the
 * unmarshaller returns a safe integer as a number, so a stream holding 2^60, 2^61, 5 and 2^62 failed
 * on every read that covered the 5. The rows the published 1.39.0 stored read through every path that
 * reads a stream, what a bigint stores doesn't move, and what packed storage does with one.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { readFileSync } from "node:fs"
import { gzipSync } from "node:zlib"
import {
  type AttributeValue,
  DynamoDBClient,
  PutItemCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { Cause, Config, Effect, Exit, Layer, Option, Schema } from "effect"
import { describe, expect } from "vitest"
import * as ZlibCompression from "../src/compression/zlib.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"

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

const credentials = { accessKeyId: "local", secretAccessKey: "local" }
const raw = new DynamoDBClient({ region: "us-east-1", endpoint: ENDPOINT, credentials })
const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials,
  compressors: [ZlibCompression.gzip()],
})

const Keys = {
  KeySchema: [
    { AttributeName: "pk", KeyType: "HASH" as const },
    { AttributeName: "sk", KeyType: "RANGE" as const },
  ],
  AttributeDefinitions: [
    { AttributeName: "pk", AttributeType: "S" as const },
    { AttributeName: "sk", AttributeType: "S" as const },
    { AttributeName: "lsi1sk", AttributeType: "S" as const },
  ],
  LocalSecondaryIndexes: [
    {
      IndexName: "lsi1",
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" as const },
        { AttributeName: "lsi1sk", KeyType: "RANGE" as const },
      ],
      Projection: { ProjectionType: "ALL" as const },
    },
  ],
}

type Row = Record<string, AttributeValue>

let tables = 0
const onTable = <A, E>(Base: any, body: (tableName: string) => Effect.Effect<A, E, any>) => {
  const tableName = `bigints-${Date.now()}-${tables++}`
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const client = yield* DynamoClient
      yield* client.createTable({ TableName: tableName, BillingMode: "PAY_PER_REQUEST", ...Keys })
    }),
    () => body(tableName),
    () =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(Effect.ignore),
  ).pipe(
    Effect.provide(Layer.merge(ClientLayer, Base.layer({ name: tableName }) as Layer.Layer<never>)),
  ) as Effect.Effect<A, unknown>
}

const put = (tableName: string, ...rows: ReadonlyArray<Row>) =>
  Effect.promise(async () => {
    for (const Item of rows) await raw.send(new PutItemCommand({ TableName: tableName, Item }))
  })

const rowsOf = (tableName: string) =>
  Effect.promise(async () => {
    const { Items = [] } = await raw.send(
      new ScanCommand({ TableName: tableName, ConsistentRead: true }),
    )
    return Items as ReadonlyArray<Row>
  })

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/stream-bigint-1.39.0.json", import.meta.url), "utf8"),
) as { readonly rows: ReadonlyArray<Row>; readonly outbox: ReadonlyArray<Row> }

const storedEvents = fixture.rows.filter((row) => row.data !== undefined)
const storedSnapshot = fixture.rows.find((row) => row.state !== undefined) as Row
const big = 2n ** 60n
const AMOUNTS = [big, big * 2n, 5n, big * 4n]

const Paid = Schema.Struct({
  _tag: Schema.tag("Paid"),
  amount: Schema.BigInt,
  orNull: Schema.NullOr(Schema.BigInt),
  optional: Schema.optional(Schema.BigInt),
  key: Schema.optionalKey(Schema.BigInt),
  list: Schema.Array(Schema.BigInt),
  byName: Schema.Record(Schema.String, Schema.BigInt),
  option: Schema.Option(Schema.BigInt),
  set: Schema.ReadonlySet(Schema.BigInt),
})
const paid = (amount: bigint) => ({
  _tag: "Paid" as const,
  amount,
  orNull: amount,
  optional: amount,
  key: amount,
  list: [amount, big],
  byName: { a: amount },
  option: Option.some(amount),
  set: new Set([amount, big]),
})

const expectPaid = (data: any, amount: bigint) => {
  expect(data.amount).toBe(amount)
  expect(data.orNull).toBe(amount)
  expect(data.optional).toBe(amount)
  expect(data.key).toBe(amount)
  expect(data.list).toEqual([amount, big])
  expect(data.byName).toEqual({ a: amount })
  expect(Option.getOrThrow(data.option as Option.Option<bigint>)).toBe(amount)
  expect(data.set).toEqual(new Set([amount, big]))
}

const Summaries = Entity.make({
  model: Schema.Struct({ id: Schema.String, version: Schema.Number, rev: Schema.Number }),
  entityType: "Summary",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
})
const Base = Table.make({
  schema: DynamoSchema.make({ name: "bigints", version: 1 }),
  entities: { Summaries },
})
const Ledger = EventStore.makeStream({
  table: Base,
  streamName: "Ledger",
  events: [Paid],
  streamId: { composite: ["id"] },
  metadata: Schema.Struct({ m: Schema.BigInt }),
  snapshot: { schema: Schema.Struct({ total: Schema.BigInt, n: Schema.Number }), mode: "inline" },
  indexes: {
    byVersion: {
      index: "lsi1",
      sk: "lsi1sk",
      key: (_event: unknown, version: number) => String(version).padStart(8, "0"),
    },
  },
} as never) as any

const id = { id: "stored" }

const expectEvents = (events: ReadonlyArray<any>, amounts: ReadonlyArray<bigint>) => {
  expect(events.map((event) => event.data.amount)).toEqual(amounts)
  events.forEach((event, at) => {
    expectPaid(event.data, amounts[at]!)
    expect(event.metadata.m).toBe(5n)
  })
}

const tally = {
  initialState: { total: 0n, n: 0 },
  decide: (command: { readonly amount: bigint }) => Effect.succeed([paid(command.amount)]),
  evolve: (state: any, event: any) => ({ total: state.total + event.amount, n: state.n + 1 }),
}

describeConnected("a stream's Schema.BigInt on DynamoDB", () => {
  describe("in the rows 1.39.0 stored", () => {
    it.effect("every read path", () =>
      onTable(Base, (tableName) =>
        Effect.gen(function* () {
          const indexed = storedEvents.map((row, at) => ({
            ...row,
            lsi1sk: { S: String(at + 1).padStart(8, "0") },
          }))
          yield* put(tableName, ...indexed, storedSnapshot)

          expectEvents(yield* Ledger.read(id), AMOUNTS)
          expectEvents(yield* Ledger.read(id, { consistentRead: true }), AMOUNTS)
          expectEvents(yield* Ledger.readFrom(id, 1), AMOUNTS.slice(1))
          expectEvents(yield* Ledger.readFrom(id, 3), AMOUNTS.slice(3))
          expectEvents(yield* Ledger.readIndex("byVersion", id), AMOUNTS)
          expectEvents((yield* Query.collect(Ledger.query.events(id))) as never, AMOUNTS)
          expectEvents(
            (yield* Query.collect(Ledger.query.index("byVersion", id))) as never,
            AMOUNTS,
          )

          const latest = yield* Ledger.readLatest(id)
          expect(Option.getOrThrow<any>(latest.snapshot).state).toEqual({ total: 5n, n: 4 })
          expect(latest.version).toBe(4)
          const snapshot = Option.getOrThrow<any>(yield* Ledger.readSnapshot(id))
          expect(snapshot.state).toEqual({ total: 5n, n: 4 })

          const small = indexed[2]!
          const image = Option.getOrThrow<any>(yield* Ledger.decodeStreamImage(small))
          expectPaid(image.data, 5n)
          expect(image.metadata.m).toBe(5n)
          const decoded = yield* EventStore.decoder({ Ledger })(small as never)
          expectPaid(Option.getOrThrow<any>(decoded).event.data, 5n)
        }),
      ),
    )

    it.effect("a command's load, from the events and from the snapshot", () =>
      onTable(Base, (tableName) =>
        Effect.gen(function* () {
          yield* put(tableName, ...storedEvents)
          const handler = EventStore.commandHandler(tally as never, Ledger) as any
          const first = yield* handler(id, { amount: 7n }, { metadata: { m: 5n } })
          expect(first.version).toBe(5)
          expect(first.state.total).toBe(AMOUNTS.reduce((sum, n) => sum + n, 0n) + 7n)

          yield* put(tableName, { ...storedSnapshot, asOfVersion: { N: "5" } })
          const unverified = EventStore.commandHandler(tally as never, Ledger, {
            verifySnapshot: false,
          } as never) as any
          const second = yield* unverified(id, { amount: 1n }, { metadata: { m: 5n } })
          expect(second.version).toBe(6)
          expect(second.state).toEqual({ total: 6n, n: 5 })
        }),
      ),
    )
  })

  it.effect("a bigint is stored as 1.39.0 stored it", () =>
    onTable(Base, (tableName) =>
      Effect.gen(function* () {
        yield* Ledger.append(id, AMOUNTS.map(paid), 0, { metadata: { m: 5n } })
        yield* Ledger.writeSnapshot(id, { total: 5n, n: 4 }, 4)
        const rows = yield* rowsOf(tableName)
        const events = rows
          .filter((row) => row.data !== undefined)
          .sort((a, b) => (a.sk!.S! < b.sk!.S! ? -1 : 1))
        expect(events.map((row) => row.data)).toEqual(storedEvents.map((row) => row.data))
        expect(events.map((row) => row.metadata)).toEqual(storedEvents.map((row) => row.metadata))
        const snapshot = rows.find((row) => row.state !== undefined) as Row
        expect(snapshot.state).toEqual(storedSnapshot.state)
      }),
    ),
  )

  it.effect("a command's inline snapshot stores its bigint, and the load reads it", () =>
    onTable(Base, () =>
      Effect.gen(function* () {
        const handler = EventStore.commandHandler(tally as never, Ledger) as any
        yield* handler(id, { amount: 5n }, { metadata: { m: 5n } })
        const second = yield* handler(id, { amount: big }, { metadata: { m: 5n } })
        expect(second.state).toEqual({ total: big + 5n, n: 2 })
        const snapshot = Option.getOrThrow<any>(yield* Ledger.readSnapshot(id))
        expect(snapshot.state).toEqual({ total: big + 5n, n: 2 })
      }),
    ),
  )

  it.effect("a value no bigint could have been stored as is still refused", () =>
    onTable(Base, (tableName) =>
      Effect.gen(function* () {
        const [row] = storedEvents
        const data = { M: { ...row!.data!.M!, amount: { N: "5.5" } } }
        yield* put(tableName, { ...row!, data } as Row)
        const exit = yield* Effect.exit(Ledger.read(id))
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    ),
  )

  describe("an outbox", () => {
    const record = (image: Row, sequence: string) => ({
      eventID: sequence,
      eventName: "INSERT",
      dynamodb: {
        SequenceNumber: sequence,
        NewImage: image,
        Keys: { pk: image.pk, sk: image.sk },
      },
    })
    const Plain = EventStore.makeStream({
      table: Base,
      streamName: "Ledger",
      events: [Paid],
      streamId: { composite: ["id"] },
      metadata: Schema.Struct({ m: Schema.BigInt }),
    } as never) as any
    const projecting = (seen: Array<unknown>) =>
      EventStore.projection({
        stream: Plain,
        readModel: Summaries,
        key: (input: any) => ({ id: input.id }),
        initial: (input: any) => ({ id: input.id, version: 0, rev: 0 }),
        evolve: (state: any, event: any) => {
          seen.push(event.data.amount)
          return Effect.succeed(state)
        },
        checkpoint: "version",
        revision: "rev",
        outbox: { schema: Schema.Struct({ total: Schema.BigInt }), effects: () => [{ total: 5n }] },
      } as never) as any

    it.effect("an item 1.39.0 stored drains a bigint", () =>
      onTable(Base, (tableName) =>
        Effect.gen(function* () {
          yield* put(tableName, ...fixture.outbox)
          const delivered: Array<any> = []
          yield* projecting([]).drain({ id: "outboxed" }, (effect: any) =>
            Effect.sync(() => {
              delivered.push(effect)
            }),
          )
          expect(delivered).toEqual([{ total: 5n }])
        }),
      ),
    )

    it.effect("a change-feed image reaches evolve a bigint, and the outbox stores as 1.39.0", () =>
      onTable(Base, (tableName) =>
        Effect.gen(function* () {
          yield* put(tableName, ...storedEvents)
          const seen: Array<unknown> = []
          yield* projecting(seen).processBatch(
            storedEvents.map((row, at) => record(row, String(at + 1))),
            { source: "lambda" },
          )
          expect(seen).toEqual(AMOUNTS)
          const rows = yield* rowsOf(tableName)
          const outbox = rows.find((row) => row.effect !== undefined) as Row
          expect(outbox.effect).toEqual(fixture.outbox[0]!.effect)
        }),
      ),
    )

    it.effect("EventStore.processBatch reaches evolve a bigint", () =>
      onTable(Base, (tableName) =>
        Effect.gen(function* () {
          yield* put(tableName, ...storedEvents)
          const seen: Array<unknown> = []
          yield* EventStore.processBatch(
            storedEvents.map((row, at) => record(row, String(at + 1))) as never,
            { projections: [projecting(seen)], source: "lambda" } as never,
          )
          expect(seen).toEqual(AMOUNTS)
        }),
      ),
    )

    it.effect("apply reaches evolve a bigint", () =>
      onTable(Base, (tableName) =>
        Effect.gen(function* () {
          yield* put(tableName, ...storedEvents)
          const seen: Array<unknown> = []
          const projected = projecting(seen)
          for (const event of yield* Plain.read(id)) yield* projected.apply(event)
          expect(seen).toEqual(AMOUNTS)
        }),
      ),
    )
  })

  describe("packed", () => {
    const Json = DynamoModel.Packed({ format: "json" })
    const Gzip = DynamoModel.Packed({
      format: "json",
      compression: { codec: "gzip", threshold: 1 },
    })
    const Event = Schema.Struct({ _tag: Schema.tag("Paid"), amount: Schema.BigInt })
    const packedStream = (storedAs: unknown) =>
      EventStore.makeStream({
        table: Base,
        streamName: "Ledger",
        events: [Event],
        streamId: { composite: ["id"] },
        snapshot: { schema: Schema.Struct({ total: Schema.BigInt }), mode: "inline", storedAs },
        storedAs: { data: storedAs },
      } as never) as any
    const failure = (exit: Exit.Exit<unknown, unknown>) => Cause.squash((exit as any).cause) as any

    for (const [name, storedAs] of [
      ["json", Json],
      ["gzip", Gzip],
    ] as const) {
      const Stream = packedStream(storedAs)

      it.effect(`${name}: an append fails with a ValidationError, whatever the value`, () =>
        onTable(Base, (tableName) =>
          Effect.gen(function* () {
            for (const amount of [5n, big]) {
              const exit = yield* Effect.exit(
                Stream.append(id, [{ _tag: "Paid", amount }], 0) as Effect.Effect<unknown, unknown>,
              )
              const error = failure(exit)
              expect(error).toBeInstanceOf(ValidationError)
              expect(String(error.cause)).toContain("data.amount is a bigint")
            }
            expect(yield* rowsOf(tableName)).toEqual([])
          }),
        ),
      )

      it.effect(`${name}: a snapshot fails with a ValidationError`, () =>
        onTable(Base, (tableName) =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(
              Stream.writeSnapshot(id, { total: 5n }, 1) as Effect.Effect<unknown, unknown>,
            )
            expect(failure(exit)).toBeInstanceOf(ValidationError)
            expect(yield* rowsOf(tableName)).toEqual([])
          }),
        ),
      )

      it.effect(`${name}: a number already in a packed row reads as a bigint`, () =>
        onTable(Base, (tableName) =>
          Effect.gen(function* () {
            const pack = (text: string): AttributeValue =>
              storedAs === Json
                ? { S: text }
                : // The header byte: version 1, json, gzip.
                  { B: Uint8Array.from([0b00100001, ...gzipSync(text)]) }
            const [row] = storedEvents
            yield* put(
              tableName,
              { ...row!, data: pack(JSON.stringify({ _tag: "Paid", amount: 5 })) } as Row,
              {
                ...storedSnapshot,
                state: pack(JSON.stringify({ total: 5 })),
                asOfVersion: { N: "1" },
              } as Row,
            )
            const [event] = yield* Stream.read(id)
            expect(event.data.amount).toBe(5n)
            const snapshot = Option.getOrThrow<any>(yield* Stream.readSnapshot(id))
            expect(snapshot.state.total).toBe(5n)
          }),
        ),
      )
    }

    it.effect("metadata isn't packed, so a packed stream's metadata takes a bigint", () =>
      onTable(Base, () =>
        Effect.gen(function* () {
          const Stream = EventStore.makeStream({
            table: Base,
            streamName: "Ledger",
            events: [Schema.Struct({ _tag: Schema.tag("Noted") })],
            streamId: { composite: ["id"] },
            metadata: Schema.Struct({ m: Schema.BigInt }),
            storedAs: { data: Json },
          } as never) as any
          yield* Stream.append(id, [{ _tag: "Noted" }], 0, { metadata: { m: 5n } })
          const [event] = yield* Stream.read(id)
          expect(event.metadata.m).toBe(5n)
        }),
      ),
    )
  })
})
