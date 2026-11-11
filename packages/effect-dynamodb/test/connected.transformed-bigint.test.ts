/**
 * A `Schema.BigInt` under a declaration, a `Schema.suspend` or a transformation, against DynamoDB
 * Local. Each stores a number, and the unmarshaller returns a safe integer as a number, so 1.39.0
 * wrote these and every read of a 5 failed. The rows the published 1.39.0 stored read through an
 * entity, an aggregate, a stream and an outbox, and what each stores doesn't move.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { readFileSync } from "node:fs"
import {
  type AttributeValue,
  DynamoDBClient,
  PutItemCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Duration, Effect, Layer, Option, Result, Schema } from "effect"
import { describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
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
const ClientLayer = DynamoClient.layer({ region: "us-east-1", endpoint: ENDPOINT, credentials })

const Keys = {
  KeySchema: [
    { AttributeName: "pk", KeyType: "HASH" as const },
    { AttributeName: "sk", KeyType: "RANGE" as const },
  ],
  AttributeDefinitions: [
    { AttributeName: "pk", AttributeType: "S" as const },
    { AttributeName: "sk", AttributeType: "S" as const },
  ],
}

type Row = Record<string, AttributeValue>

let tables = 0
const onTable = <A, E>(Base: any, body: (tableName: string) => Effect.Effect<A, E, any>) => {
  const tableName = `transformed-bigints-${Date.now()}-${tables++}`
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

const byKey = (a: Row, b: Row) => (a.pk!.S! + a.sk!.S! < b.pk!.S! + b.sk!.S! ? -1 : 1)

const rowsOf = (tableName: string) =>
  Effect.promise(async () => {
    const { Items = [] } = await raw.send(
      new ScanCommand({ TableName: tableName, ConsistentRead: true }),
    )
    return [...(Items as ReadonlyArray<Row>)].sort(byKey)
  })

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/transformed-bigint-1.39.0.json", import.meta.url), "utf8"),
) as Record<"entity" | "aggregate" | "stream" | "outbox", ReadonlyArray<Row>>

const big = 2n ** 60n
const AMOUNTS = [
  ["small", 5n],
  ["big", big],
] as const

type Tree = { readonly n: bigint; readonly next?: Tree }
const Tree: Schema.Codec<Tree, any> = Schema.Struct({
  n: Schema.BigInt,
  next: Schema.optionalKey(Schema.suspend((): Schema.Codec<Tree, any> => Tree)),
})

const AggregateFields = {
  option: Schema.Option(Schema.BigInt),
  none: Schema.Option(Schema.BigInt),
  optionStruct: Schema.Option(Schema.Struct({ b: Schema.BigInt })),
  result: Schema.Result(Schema.BigInt, Schema.String),
  set: Schema.ReadonlySet(Schema.BigInt),
  suspended: Schema.suspend(() => Schema.BigInt),
  tree: Tree,
  bytes: Schema.ByteSizeFromBigInt,
}
const Fields = {
  ...AggregateFields,
  nanos: Schema.DurationFromNanos,
  fromNull: Schema.OptionFromNullOr(Schema.BigInt),
  fromNullNone: Schema.OptionFromNullOr(Schema.BigInt),
}

const aggregateValuesOf = (n: bigint) => ({
  option: Option.some(n),
  none: Option.none<bigint>(),
  optionStruct: Option.some({ b: n }),
  result: Result.succeed(n),
  set: new Set([n]),
  suspended: n,
  tree: { n, next: { n } },
  bytes: n,
})
const valuesOf = (n: bigint) => ({
  ...aggregateValuesOf(n),
  nanos: Duration.nanos(n),
  fromNull: Option.some(n),
  fromNullNone: Option.none<bigint>(),
})

const expectFields = (read: any, values: Record<string, unknown>) => {
  for (const [name, value] of Object.entries(values)) expect(read[name]).toEqual(value)
}

const Accounts = Entity.make({
  model: Schema.Struct({ id: Schema.String, note: Schema.optional(Schema.String), ...Fields }),
  entityType: "Account",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
} as never) as any
const Summaries = Entity.make({
  model: Schema.Struct({ id: Schema.String, version: Schema.Number, rev: Schema.Number }),
  entityType: "Summary",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
})
const AppSchema = DynamoSchema.make({ name: "bigints", version: 1 })
const Base = Table.make({ schema: AppSchema, entities: { Accounts, Summaries } })

const Ledgers = (Aggregate.make as any)(
  Schema.Struct({
    id: Schema.String,
    note: Schema.optional(Schema.String),
    ...AggregateFields,
    lines: Schema.Array(Schema.Struct({ sku: Schema.String, ...AggregateFields })),
  }),
  {
    table: Base,
    schema: Base.schema,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "ledgers" },
    root: { entityType: "Ledger" },
    edges: { lines: Aggregate.many({ entityType: "Line", sk: { composite: ["sku"] } } as never) },
  },
)
const MainTable = { ...Base, aggregates: { Ledgers } }
const client = DynamoClient.make({
  entities: { Accounts },
  aggregates: { Ledgers },
  tables: { MainTable },
} as never) as Effect.Effect<any, never, any>

const Paid = Schema.Struct({ _tag: Schema.tag("Paid"), ...Fields })
const Tally = EventStore.makeStream({
  table: Base,
  streamName: "Tally",
  events: [Paid],
  streamId: { composite: ["id"] },
  metadata: Schema.Struct({ m: Schema.Option(Schema.BigInt) }),
  snapshot: { schema: Schema.Struct(Fields), mode: "inline" },
} as never) as any
const projecting = (seen: Array<unknown>) =>
  EventStore.projection({
    stream: Tally,
    readModel: Summaries,
    key: (input: any) => ({ id: input.id }),
    initial: (input: any) => ({ id: input.id, version: 0, rev: 0 }),
    evolve: (state: any, event: any) => {
      seen.push(event.data)
      return Effect.succeed(state)
    },
    checkpoint: "version",
    revision: "rev",
    outbox: { schema: Schema.Struct(Fields), effects: () => [valuesOf(5n)] },
  } as never) as any

describeConnected("a bigint under a declaration, a suspend or a transformation", () => {
  describe("in the rows 1.39.0 stored", () => {
    it.effect("an entity reads them, and an update moves only what it sets", () =>
      onTable(Base, (tableName) =>
        Effect.gen(function* () {
          yield* put(tableName, ...fixture.entity)
          const db = yield* client

          for (const [id, n] of AMOUNTS) {
            expectFields(yield* db.entities.Accounts.get({ id }), valuesOf(n))
          }
          const scanned: ReadonlyArray<any> = yield* db.entities.Accounts.scan().collect()
          expect(scanned.length).toBe(2)
          for (const read of scanned) expectFields(read, valuesOf(read.id === "big" ? big : 5n))

          for (const [id, n] of AMOUNTS) {
            const updated = yield* db.entities.Accounts.update({ id }).set({ note: "n" })
            expectFields(updated, valuesOf(n))
            expectFields(yield* db.entities.Accounts.get({ id }), valuesOf(n))
          }
          const rows = yield* rowsOf(tableName)
          expect(rows).toEqual(
            [...fixture.entity].sort(byKey).map((row) => ({ ...row, note: { S: "n" } })),
          )
        }),
      ),
    )

    it.effect("an aggregate reads them, and an update moves only what it sets", () =>
      onTable(Base, (tableName) =>
        Effect.gen(function* () {
          yield* put(tableName, ...fixture.aggregate)
          const db = yield* client

          const expectLedger = (read: any, n: bigint) => {
            expectFields(read, aggregateValuesOf(n))
            expect(read.lines.length).toBe(1)
            expectFields(read.lines[0], { sku: "a", ...aggregateValuesOf(n) })
          }
          for (const [id, n] of AMOUNTS) {
            expectLedger(yield* db.aggregates.Ledgers.get({ id: `ledger-${id}` }), n)
          }
          for (const [id, n] of AMOUNTS) {
            const updated = yield* db.aggregates.Ledgers.update(
              { id: `ledger-${id}` },
              ({ state }: any) => ({ ...state, note: "n" }),
            )
            expect(updated.note).toBe("n")
            expectLedger(updated, n)
            expectLedger(yield* db.aggregates.Ledgers.get({ id: `ledger-${id}` }), n)
          }
          const rows = yield* rowsOf(tableName)
          expect(rows).toEqual(
            [...fixture.aggregate]
              .sort(byKey)
              .map((row) => (row.id === undefined ? row : { ...row, note: { S: "n" } })),
          )
        }),
      ),
    )

    it.effect("a stream reads them, through every path that reads one", () =>
      onTable(Base, (tableName) =>
        Effect.gen(function* () {
          yield* put(tableName, ...fixture.stream)
          for (const [name, n] of AMOUNTS) {
            const id = { id: `stored-${name}` }
            const expectEvent = (event: any) => {
              expectFields(event.data, valuesOf(n))
              expect(event.metadata.m).toEqual(Option.some(n))
            }
            const events: ReadonlyArray<any> = yield* Tally.read(id)
            expect(events.length).toBe(1)
            expectEvent(events[0])
            expectEvent((yield* Tally.readFrom(id, 0))[0])

            const latest = yield* Tally.readLatest(id)
            expect(latest.version).toBe(1)
            expectFields(Option.getOrThrow<any>(latest.snapshot).state, valuesOf(n))
            const snapshot = Option.getOrThrow<any>(yield* Tally.readSnapshot(id))
            expectFields(snapshot.state, valuesOf(n))

            const row = fixture.stream.find(
              (stored) => stored.data !== undefined && stored.pk!.S!.endsWith(id.id),
            ) as Row
            expectEvent(Option.getOrThrow(yield* Tally.decodeStreamImage(row)))
          }
        }),
      ),
    )

    it.effect("a command's load folds them", () =>
      onTable(Base, (tableName) =>
        Effect.gen(function* () {
          yield* put(
            tableName,
            ...fixture.stream.filter(
              (row) => row.data !== undefined && row.pk!.S!.endsWith("stored-small"),
            ),
          )
          const seen: Array<unknown> = []
          const handler = EventStore.commandHandler(
            {
              initialState: valuesOf(0n),
              decide: () => Effect.succeed([{ _tag: "Paid", ...valuesOf(7n) }]),
              evolve: (_state: any, event: any) => {
                seen.push(event.option)
                const { _tag, ...state } = event
                return state
              },
            } as never,
            Tally,
          ) as any
          const result = yield* handler(
            { id: "stored-small" },
            {},
            { metadata: { m: Option.none() } },
          )
          expect(seen).toEqual([Option.some(5n), Option.some(7n)])
          expect(result.version).toBe(2)
          expectFields(result.state, valuesOf(7n))
        }),
      ),
    )

    it.effect("an outbox drains them", () =>
      onTable(Base, (tableName) =>
        Effect.gen(function* () {
          yield* put(tableName, ...fixture.outbox)
          const delivered: Array<any> = []
          yield* projecting([]).drain({ id: "outboxed" }, (effect: any) =>
            Effect.sync(() => {
              delivered.push(effect)
            }),
          )
          expect(delivered.length).toBe(1)
          expectFields(delivered[0], valuesOf(5n))
        }),
      ),
    )

    it.effect("a change-feed image reaches evolve read", () =>
      onTable(Base, (tableName) =>
        Effect.gen(function* () {
          const row = fixture.stream.find(
            (stored) => stored.data !== undefined && stored.pk!.S!.endsWith("stored-small"),
          ) as Row
          yield* put(tableName, row)
          const seen: Array<unknown> = []
          yield* projecting(seen).processBatch(
            [
              {
                eventID: "1",
                eventName: "INSERT",
                dynamodb: {
                  SequenceNumber: "1",
                  NewImage: row,
                  Keys: { pk: row.pk, sk: row.sk },
                },
              },
            ],
            { source: "lambda" },
          )
          expect(seen.length).toBe(1)
          expectFields(seen[0], valuesOf(5n))
        }),
      ),
    )
  })

  describe("what's stored doesn't move", () => {
    it.effect("an entity's put", () =>
      onTable(Base, (tableName) =>
        Effect.gen(function* () {
          const db = yield* client
          for (const [id, n] of AMOUNTS) {
            expectFields(yield* db.entities.Accounts.put({ id, ...valuesOf(n) }), valuesOf(n))
          }
          expect(yield* rowsOf(tableName)).toEqual([...fixture.entity].sort(byKey))
        }),
      ),
    )

    it.effect("an aggregate's create", () =>
      onTable(Base, (tableName) =>
        Effect.gen(function* () {
          const db = yield* client
          for (const [id, n] of AMOUNTS) {
            const created = yield* db.aggregates.Ledgers.create({
              id: `ledger-${id}`,
              ...aggregateValuesOf(n),
              lines: [{ sku: "a", ...aggregateValuesOf(n) }],
            })
            expectFields(created, aggregateValuesOf(n))
          }
          expect(yield* rowsOf(tableName)).toEqual([...fixture.aggregate].sort(byKey))
        }),
      ),
    )

    it.effect("a stream's append and snapshot, and an outbox", () =>
      onTable(Base, (tableName) =>
        Effect.gen(function* () {
          for (const [name, n] of AMOUNTS) {
            const id = { id: `stored-${name}` }
            yield* Tally.append(id, [{ _tag: "Paid", ...valuesOf(n) }], 0, {
              metadata: { m: Option.some(n) },
            })
            yield* Tally.writeSnapshot(id, valuesOf(n), 1)
          }
          const rows = yield* rowsOf(tableName)
          const stored = [...fixture.stream].sort(byKey)
          expect(rows.map((row) => row.data)).toEqual(stored.map((row) => row.data))
          expect(rows.map((row) => row.metadata)).toEqual(stored.map((row) => row.metadata))
          expect(rows.map((row) => row.state)).toEqual(stored.map((row) => row.state))

          yield* projecting([]).apply({
            streamId: "outboxed",
            streamName: "Tally",
            version: 1,
            eventType: "Paid",
            data: { _tag: "Paid", ...valuesOf(5n) },
            metadata: { m: Option.none() },
            timestamp: "2025-01-01T00:00:00.000Z",
          })
          const outbox = (yield* rowsOf(tableName)).find((row) => row.effect !== undefined) as Row
          expect(outbox.effect).toEqual(fixture.outbox[0]!.effect)
        }),
      ),
    )
  })

  describe("what 1.39.0's aggregate wouldn't create", () => {
    const Field = (Aggregate.make as any)(
      Schema.Struct({
        id: Schema.String,
        note: Schema.optional(Schema.String),
        nanos: Schema.DurationFromNanos,
        fromNull: Schema.OptionFromNullOr(Schema.BigInt),
        fromNullNone: Schema.OptionFromNullOr(Schema.BigInt),
      }),
      {
        table: Base,
        schema: Base.schema,
        pk: { field: "pk", composite: ["id"] },
        collection: { name: "fields" },
        root: { entityType: "Field" },
        edges: {},
      },
    )
    const FieldTable = { ...Base, aggregates: { Field } }
    const fields = DynamoClient.make({
      entities: {},
      aggregates: { Field },
      tables: { FieldTable },
    } as never) as Effect.Effect<any, never, any>

    for (const [name, n] of AMOUNTS) {
      it.effect(`stores what an entity stores for it, and reads it: ${name}`, () =>
        onTable(Base, (tableName) =>
          Effect.gen(function* () {
            const db = yield* fields
            const values = {
              nanos: Duration.nanos(n),
              fromNull: Option.some(n),
              fromNullNone: Option.none<bigint>(),
            }
            expectFields(yield* db.aggregates.Field.create({ id: "a", ...values }), values)
            expectFields(yield* db.aggregates.Field.get({ id: "a" }), values)
            const [row] = yield* rowsOf(tableName)
            const account = fixture.entity.find((stored) => stored.id!.S === name) as Row
            expect(row!.nanos).toEqual(account.nanos)
            expect(row!.fromNull).toEqual(account.fromNull)
            expect(row!.fromNullNone).toEqual(account.fromNullNone)

            const updated = yield* db.aggregates.Field.update({ id: "a" }, ({ state }: any) => ({
              ...state,
              note: "n",
            }))
            expectFields(updated, values)
            const [after] = yield* rowsOf(tableName)
            expect(after).toEqual({ ...row, note: { S: "n" } })
          }),
        ),
      )
    }
  })

  describe("a union a read can tell apart", () => {
    const Later = Schema.Struct({ a: Schema.BigInt })
    const Earlier = Schema.Struct({ a: Schema.Number, c: Schema.String })
    const taken = [
      [
        "an Option before a struct with no field in common",
        Schema.Union([
          Schema.Option(Schema.BigInt),
          Schema.Struct({ x: Schema.optional(Schema.String) }),
        ]),
        [Option.some(5n), Option.none(), { x: "s" }],
      ],
      [
        "a struct that requires more first",
        Schema.Union([Earlier, Later]),
        [{ a: 5, c: "s" }, { a: 5n }],
      ],
      [
        "a transformation before what it can't take",
        Schema.Union([Schema.DurationFromNanos, Schema.String]),
        [Duration.nanos(5n), "s"],
      ],
      [
        "a suspend before what it can't take",
        Schema.Union([Schema.suspend(() => Schema.BigInt), Schema.String]),
        [5n, "s"],
      ],
    ] as const
    for (const [name, field, values] of taken) {
      it.effect(`on a stream, ${name}`, () =>
        onTable(Base, () =>
          Effect.gen(function* () {
            const Held = Schema.Struct({ _tag: Schema.tag("Held"), f: field as never })
            const Stream = EventStore.makeStream({
              table: Base,
              streamName: "Held",
              events: [Held],
              streamId: { composite: ["id"] },
            } as never) as any
            const id = { id: "held" }
            yield* Stream.append(
              id,
              values.map((f) => ({ _tag: "Held", f })),
              0,
            )
            const events: ReadonlyArray<any> = yield* Stream.read(id)
            expect(events.map((event) => event.data.f)).toEqual([...values])
          }),
        ),
      )
    }
  })

  it.effect("a value no bigint could have been stored as is still refused", () =>
    onTable(Base, (tableName) =>
      Effect.gen(function* () {
        const [row] = fixture.entity
        const option = { M: { ...row!.option!.M!, value: { N: "5.5" } } }
        yield* put(tableName, { ...row!, option } as Row)
        const db = yield* client
        const exit = yield* Effect.exit(db.entities.Accounts.get({ id: row!.id!.S! }))
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )
})
