/**
 * What `[EDD-9125]` leaves standing, against DynamoDB Local: a map whose stored side isn't a map,
 * and the `Schema.Record` the refusal points to, which reads what a map field stored.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { DynamoDBClient, PutItemCommand, ScanCommand } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Effect, Layer, Schema, SchemaGetter } from "effect"
import { describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import { toAttributeMap } from "../src/Marshaller.js"
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

const AppSchema = DynamoSchema.make({ name: "maps", version: 1 })
const Counts = Schema.ReadonlyMap(Schema.String, Schema.Number)
const Text = Schema.Record(Schema.String, Schema.Number)

const Decoded = Text.pipe(
  Schema.decodeTo(Counts, {
    decode: SchemaGetter.transform((text) => new Map(Object.entries(text))),
    encode: SchemaGetter.transform((counts) => Object.fromEntries(counts)),
  }),
)

const entityOver = (field: Schema.Top) =>
  Entity.make({
    model: Schema.Struct({
      id: Schema.String,
      f: field as never,
      n: Schema.optional(Schema.Number),
    }),
    entityType: "Row",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  } as never) as any

let tables = 0
const rowsOf = (tableName: string) =>
  Effect.promise(async () => {
    const { Items = [] } = await raw.send(
      new ScanCommand({ TableName: tableName, ConsistentRead: true }),
    )
    return Items
  })

/** The keys every model here uses, for a table with no entity to derive them from. */
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

/** `body` on a fresh table of that definition. */
const onTable = <A, E>(
  definition: any,
  Base: any,
  body: (tableName: string) => Effect.Effect<A, E, any>,
) => {
  const tableName = `maps-${Date.now()}-${tables++}`
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const client = yield* DynamoClient
      yield* client.createTable({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        ...definition,
      })
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

describeConnected("what [EDD-9125] leaves standing", () => {
  const counts = new Map([["a", 1]])

  for (const [name, field] of [
    ["a map decoded from a record", Decoded],
    ["Schema.toCodecJson of a map", Schema.toCodecJson(Counts)],
  ] as const) {
    it.effect(`${name} is stored, read, updated and read again`, () => {
      const Rows = entityOver(field)
      const MainTable = Table.make({ schema: AppSchema, entities: { Rows } })
      return onTable(Keys, MainTable, () =>
        Effect.gen(function* () {
          const db: any = yield* DynamoClient.make({ entities: { Rows }, tables: { MainTable } })
          yield* db.entities.Rows.put({ id: "a", f: counts }).asEffect()
          expect((yield* db.entities.Rows.get({ id: "a" })).f).toEqual(counts)
          const updated = yield* db.entities.Rows.update({ id: "a" }).set({ n: 1 }).asEffect()
          expect(updated.f).toEqual(counts)
          expect((yield* db.entities.Rows.get({ id: "a" })).n).toBe(1)
        }),
      )
    })
  }

  it.effect("Schema.Record reads the row a map field stored, so switching needs no rewrite", () => {
    const Rows = entityOver(Text)
    const MainTable = Table.make({ schema: AppSchema, entities: { Rows } })
    return onTable(Keys, MainTable, (tableName) =>
      Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({ entities: { Rows }, tables: { MainTable } })
        yield* db.entities.Rows.put({ id: "a", f: { b: 2 } }).asEffect()
        const [row] = yield* rowsOf(tableName)

        const fromMap = toAttributeMap({ f: new Map([["b", 2]]) })
        expect(row?.f).toEqual(fromMap.f)

        yield* Effect.promise(() =>
          raw.send(new PutItemCommand({ TableName: tableName, Item: { ...row, ...fromMap } })),
        )
        expect((yield* db.entities.Rows.get({ id: "a" })).f).toEqual({ b: 2 })
        const updated = yield* db.entities.Rows.update({ id: "a" }).set({ n: 1 }).asEffect()
        expect(updated.f).toEqual({ b: 2 })
      }),
    )
  })

  const emptyTable = () => Table.make({ schema: AppSchema, entities: {} })
  const noted = (field: Schema.Top) =>
    Schema.Struct({ _tag: Schema.tag("Noted"), m: field as never })
  const Plain = Schema.Struct({ _tag: Schema.tag("Plain") })
  const Packed = DynamoModel.Packed({ format: "json" })

  for (const [name, field] of [
    ["a map decoded from a record", Decoded],
    ["Schema.toCodecJson of a map", Schema.toCodecJson(Counts)],
  ] as const) {
    for (const [storage, storedAs] of [
      ["native", undefined],
      ["packed", Packed],
    ] as const) {
      it.effect(`${name}, ${storage}, in an event, metadata and a snapshot, reads back`, () => {
        const Base = emptyTable()
        const State = Schema.Struct({ m: field as never })
        const Events = EventStore.makeStream({
          table: Base,
          streamName: "Tally",
          events: [noted(field)],
          streamId: { composite: ["id"] },
          metadata: Schema.Struct({ m: field as never }),
          snapshot: { schema: State, ...(storedAs === undefined ? {} : { storedAs }) },
          ...(storedAs === undefined ? {} : { storedAs: { data: storedAs } }),
        } as never) as any
        return onTable(Keys, Base, () =>
          Effect.gen(function* () {
            const id = { id: "a" }
            yield* Events.append(id, [{ _tag: "Noted", m: counts }], 0, {
              metadata: { m: counts },
            })
            const [event] = yield* Events.read(id)
            expect(event.data.m).toEqual(counts)
            expect(event.metadata.m).toEqual(counts)
            yield* Events.writeSnapshot(id, { m: counts }, 1)
            const latest = yield* Events.readLatest(id)
            expect(latest.snapshot.value.state.m).toEqual(counts)
          }),
        )
      })
    }
  }

  it.effect("Schema.Record reads the events, metadata and snapshot a map stored", () => {
    const Base = emptyTable()
    const State = Schema.Struct({ m: Text })
    const Events = EventStore.makeStream({
      table: Base,
      streamName: "Tally",
      events: [noted(Text), Plain],
      streamId: { composite: ["id"] },
      metadata: Schema.Struct({ m: Text }),
      snapshot: { schema: State },
    } as never) as any
    return onTable(Keys, Base, (tableName) =>
      Effect.gen(function* () {
        const id = { id: "a" }
        yield* Events.append(id, [{ _tag: "Noted", m: { b: 2 } }], 0, { metadata: { m: { b: 2 } } })
        yield* Events.writeSnapshot(id, { m: { b: 2 } }, 1)

        // Each row as it was stored when these fields were maps: the same bytes.
        const stored = yield* rowsOf(tableName)
        const asMap = toAttributeMap({ m: new Map([["b", 2]]) })
        const event = stored.find((row) => row.data !== undefined)!
        expect(event.data?.M?.m).toEqual(asMap.m)
        expect(event.metadata?.M?.m).toEqual(asMap.m)
        const snapshot = stored.find((row) => row.state !== undefined)!
        expect(snapshot.state?.M?.m).toEqual(asMap.m)

        const [read] = yield* Events.read(id)
        expect(read.data.m).toEqual({ b: 2 })
        expect(read.metadata.m).toEqual({ b: 2 })
        const latest = yield* Events.readLatest(id)
        expect(latest.snapshot.value.state.m).toEqual({ b: 2 })
      }),
    )
  })

  for (const [name, field, value] of [
    ["a map decoded from a record", Decoded, counts],
    ["Schema.toCodecJson of a map", Schema.toCodecJson(Counts), counts],
    ["a record", Text, { a: 1 }],
  ] as const) {
    it.effect(`${name} in an outbox effect is committed and delivered`, () => {
      const Summaries = Entity.make({
        model: Schema.Struct({ id: Schema.String, version: Schema.Number, rev: Schema.Number }),
        entityType: "Summary",
        primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
      })
      const Base = Table.make({ schema: AppSchema, entities: { Summaries } })
      const Events = EventStore.makeStream({
        table: Base,
        streamName: "Tally",
        events: [Plain],
        streamId: { composite: ["id"] },
      } as never) as any
      const Projected = EventStore.projection({
        stream: Events,
        readModel: Summaries,
        key: (id: { readonly id: string }) => ({ id: id.id }),
        initial: (id: { readonly id: string }) => ({ id: id.id, version: 0, rev: 0 }),
        evolve: (state: unknown) => Effect.succeed(state),
        checkpoint: "version",
        revision: "rev",
        outbox: { schema: Schema.Struct({ m: field as never }), effects: () => [{ m: value }] },
      } as never) as any
      return onTable(Keys, Base, (tableName) =>
        Effect.gen(function* () {
          const id = { id: "a" }
          yield* Events.append(id, [{ _tag: "Plain" }], 0)
          const [event] = yield* Events.read(id)
          yield* Projected.apply(event)
          const delivered: Array<unknown> = []
          const drained = yield* Projected.drain(id, (effect: unknown) =>
            Effect.sync(() => {
              delivered.push(effect)
            }),
          )
          expect(drained.delivered).toBe(1)
          expect(delivered).toEqual([{ m: value }])
          const rows = yield* rowsOf(tableName)
          expect(rows.filter((row) => row.__edd_e__?.S === "Summary#outbox")).toEqual([])
        }),
      )
    })
  }

  it.effect("a many edge over a record is created, read and updated", () => {
    const Line = Schema.Struct({ sku: Schema.String, qty: Schema.Number })
    const Base = Table.make({ schema: AppSchema, entities: {} })
    const Keyed = (Aggregate.make as any)(
      Schema.Struct({
        id: Schema.String,
        note: Schema.optional(Schema.String),
        lines: Schema.Record(Schema.String, Line),
      }),
      {
        table: Base,
        schema: Base.schema,
        pk: { field: "pk", composite: ["id"] },
        collection: { name: "keyed" },
        root: { entityType: "Keyed" },
        edges: {
          lines: Aggregate.many({
            entityType: "Line",
            sk: { composite: ["sku"] },
            decompose: (rows: Record<string, unknown>) => Object.values(rows),
            assemble: (rows: ReadonlyArray<any>) =>
              Object.fromEntries(rows.map((row) => [row.sku, row])),
          } as never),
        },
      },
    )
    const MainTable = { ...Base, aggregates: { Keyed } }
    return onTable(Keys, Base, () =>
      Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({
          entities: {},
          aggregates: { Keyed },
          tables: { MainTable },
        } as never)
        const lines = { s: { sku: "s", qty: 1 } }
        yield* db.aggregates.Keyed.create({ id: "a", lines })
        expect((yield* db.aggregates.Keyed.get({ id: "a" })).lines).toEqual(lines)
        yield* db.aggregates.Keyed.update({ id: "a" }, ({ state }: any) => ({
          ...state,
          note: "n",
        }))
        const read = yield* db.aggregates.Keyed.get({ id: "a" })
        expect(read.note).toBe("n")
        expect(read.lines).toEqual(lines)
      }),
    )
  })
})
